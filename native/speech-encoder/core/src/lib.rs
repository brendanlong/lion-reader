//! Speech encoding for cloud voices: interleaved 16-bit PCM in, mono AAC-LC
//! access units out, with Fraunhofer's FDK AAC (the encoder Android ships).
//!
//! Raw access units, not ADTS: the caller puts them in MP4, which carries the
//! [`SpeechEncoder::audio_specific_config`] once instead of a header per frame.

use fdk_aac_sys as sys;
use std::ffi::c_void;
use std::mem::{self, MaybeUninit};
use std::os::raw::c_int;
use std::ptr;

#[derive(Debug, PartialEq, Eq)]
pub struct EncodeError(String);

impl std::fmt::Display for EncodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EncodeError {}

fn check(call: &str, code: sys::AACENC_ERROR) -> Result<(), EncodeError> {
    if code == sys::AACENC_ERROR_AACENC_OK {
        Ok(())
    } else {
        Err(EncodeError(format!(
            "{call} failed: AAC encoder error {code:#x}"
        )))
    }
}

/// An AAC-LC encoder for one stream of speech.
pub struct SpeechEncoder {
    handle: sys::HANDLE_AACENCODER,
    channels: usize,
    /// Mono samples waiting for a whole frame.
    pending: Vec<i16>,
    /// A partial interleaved frame (fewer samples than channels) from the last push.
    carry: Vec<i16>,
    frame_samples: usize,
    max_frame_bytes: usize,
    config: Vec<u8>,
    flushed: bool,
}

/// `aacEncOpen`'s module bit for the core AAC encoder.
const AAC_MODULE: u32 = 0x01;

// One thread at a time: callers hold it by `&mut` (napi) or own it.
unsafe impl Send for SpeechEncoder {}

impl SpeechEncoder {
    /// An encoder for `channels`-channel PCM at `sample_rate`, encoded as mono
    /// at `bit_rate` bits per second.
    pub fn new(sample_rate: u32, channels: u32, bit_rate: u32) -> Result<Self, EncodeError> {
        if channels == 0 {
            return Err(EncodeError(
                "Speech audio needs at least one channel".into(),
            ));
        }
        let mut handle: sys::HANDLE_AACENCODER = ptr::null_mut();
        // Just the AAC module: the default (0) allocates SBR, PS, MPEG Surround
        // and metadata encoders too, several hundred KB we never use.
        check("aacEncOpen", unsafe {
            sys::aacEncOpen(&mut handle, AAC_MODULE, 1)
        })?;
        // Owned from here, so Drop closes it on any error below.
        let mut encoder = SpeechEncoder {
            handle,
            channels: channels as usize,
            pending: Vec::new(),
            carry: Vec::new(),
            frame_samples: 0,
            max_frame_bytes: 0,
            config: Vec::new(),
            flushed: false,
        };
        let params = [
            (
                sys::AACENC_PARAM_AACENC_AOT,
                sys::AUDIO_OBJECT_TYPE_AOT_AAC_LC as u32,
            ),
            (sys::AACENC_PARAM_AACENC_SAMPLERATE, sample_rate),
            (sys::AACENC_PARAM_AACENC_CHANNELMODE, 1), // mono
            (sys::AACENC_PARAM_AACENC_BITRATEMODE, 0), // constant
            (sys::AACENC_PARAM_AACENC_BITRATE, bit_rate),
            (sys::AACENC_PARAM_AACENC_TRANSMUX, 0), // raw access units
            (sys::AACENC_PARAM_AACENC_AFTERBURNER, 1), // better quality, more CPU
        ];
        for (param, value) in params {
            check("aacEncoder_SetParam", unsafe {
                sys::aacEncoder_SetParam(encoder.handle, param, value)
            })?;
        }
        // Applies the parameters (no buffers: initialization only).
        check("aacEncEncode", unsafe {
            sys::aacEncEncode(
                encoder.handle,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
            )
        })?;
        let mut info = MaybeUninit::<sys::AACENC_InfoStruct>::uninit();
        check("aacEncInfo", unsafe {
            sys::aacEncInfo(encoder.handle, info.as_mut_ptr())
        })?;
        let info = unsafe { info.assume_init() };
        encoder.frame_samples = info.frameLength as usize;
        encoder.max_frame_bytes = info.maxOutBufBytes as usize;
        encoder.config = info.confBuf[..info.confSize as usize].to_vec();
        Ok(encoder)
    }

    /// The MPEG-4 AudioSpecificConfig, for the MP4 sample description.
    pub fn audio_specific_config(&self) -> &[u8] {
        &self.config
    }

    /// Samples per access unit (1024 for AAC-LC).
    pub fn frame_samples(&self) -> usize {
        self.frame_samples
    }

    /// Encodes more interleaved PCM: the access units it completes, in order.
    pub fn encode(&mut self, pcm: &[i16]) -> Result<Vec<Vec<u8>>, EncodeError> {
        if self.flushed {
            return Err(EncodeError("Speech encoder already finished".into()));
        }
        let mut interleaved = mem::take(&mut self.carry);
        interleaved.extend_from_slice(pcm);
        let whole = interleaved.len() - interleaved.len() % self.channels;
        self.carry = interleaved.split_off(whole);
        let channels = self.channels as i32;
        self.pending
            .extend(interleaved.chunks_exact(self.channels).map(|frame| {
                (frame.iter().map(|&sample| i32::from(sample)).sum::<i32>() / channels) as i16
            }));

        let mut units = Vec::new();
        let mut consumed = 0;
        while self.pending.len() - consumed >= self.frame_samples {
            let frame = &self.pending[consumed..consumed + self.frame_samples];
            let (taken, unit) = self.call(Some(frame))?;
            consumed += taken;
            units.extend(unit);
        }
        self.pending.drain(..consumed);
        Ok(units)
    }

    /// Encodes what's left, padding the last frame, and flushes the encoder's
    /// delay: the final access units. Frees the encoder (see [`Self::close`]).
    pub fn finish(&mut self) -> Result<Vec<Vec<u8>>, EncodeError> {
        let units = self.flush();
        self.close();
        units
    }

    /// Frees the encoder now, rather than whenever this is dropped (for the JS
    /// wrapper, whenever V8 gets round to collecting it). Encoding after this
    /// fails.
    pub fn close(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                sys::aacEncClose(&mut self.handle);
            }
            self.handle = ptr::null_mut();
        }
        self.flushed = true;
        self.pending = Vec::new();
        self.carry = Vec::new();
    }

    fn flush(&mut self) -> Result<Vec<Vec<u8>>, EncodeError> {
        if self.flushed {
            return Ok(Vec::new());
        }
        let mut units = Vec::new();
        if !self.pending.is_empty() {
            let mut frame = mem::take(&mut self.pending);
            frame.resize(self.frame_samples, 0);
            let mut consumed = 0;
            while consumed < frame.len() {
                let (taken, unit) = self.call(Some(&frame[consumed..]))?;
                consumed += taken;
                units.extend(unit);
            }
        }
        self.flushed = true;
        loop {
            match self.call(None) {
                Ok((_, Some(unit))) => units.push(unit),
                Ok((_, None)) => break,
                Err(error) => return Err(error),
            }
        }
        Ok(units)
    }

    /// One encoder call on `input` (None flushes): the samples it took, and
    /// the access unit it put out, if any (none once flushing has ended).
    fn call(&self, input: Option<&[i16]>) -> Result<(usize, Option<Vec<u8>>), EncodeError> {
        let mut out = vec![0u8; self.max_frame_bytes];
        let samples = input.unwrap_or(&[]);

        let mut in_ptr = samples.as_ptr() as *mut c_void;
        let mut in_id: c_int = sys::AACENC_BufferIdentifier_IN_AUDIO_DATA as c_int;
        let mut in_size: c_int = mem::size_of_val(samples) as c_int;
        let mut in_el_size: c_int = mem::size_of::<i16>() as c_int;
        let in_desc = sys::AACENC_BufDesc {
            numBufs: 1,
            bufs: &mut in_ptr,
            bufferIdentifiers: &mut in_id,
            bufSizes: &mut in_size,
            bufElSizes: &mut in_el_size,
        };
        let mut out_ptr = out.as_mut_ptr() as *mut c_void;
        let mut out_id: c_int = sys::AACENC_BufferIdentifier_OUT_BITSTREAM_DATA as c_int;
        let mut out_size: c_int = out.len() as c_int;
        let mut out_el_size: c_int = 1;
        let out_desc = sys::AACENC_BufDesc {
            numBufs: 1,
            bufs: &mut out_ptr,
            bufferIdentifiers: &mut out_id,
            bufSizes: &mut out_size,
            bufElSizes: &mut out_el_size,
        };
        let in_args = sys::AACENC_InArgs {
            // -1 asks the encoder to flush what it's holding.
            numInSamples: if input.is_some() {
                samples.len() as c_int
            } else {
                -1
            },
            numAncBytes: 0,
        };
        let mut out_args = MaybeUninit::<sys::AACENC_OutArgs>::zeroed();
        let code = unsafe {
            sys::aacEncEncode(
                self.handle,
                &in_desc,
                &out_desc,
                &in_args,
                out_args.as_mut_ptr(),
            )
        };
        if input.is_none() && code == sys::AACENC_ERROR_AACENC_ENCODE_EOF {
            return Ok((0, None));
        }
        check("aacEncEncode", code)?;
        let out_args = unsafe { out_args.assume_init() };
        let taken = out_args.numInSamples as usize;
        if input.is_some() && taken == 0 && out_args.numOutBytes == 0 {
            return Err(EncodeError("AAC encoder made no progress".into()));
        }
        // Copied out at its size: `out` is a worst-case frame, kilobytes for a
        // unit of a few hundred bytes, and the unit lives on in JS until GC.
        let unit = &out[..out_args.numOutBytes as usize];
        Ok((taken, (!unit.is_empty()).then(|| unit.to_vec())))
    }
}

impl Drop for SpeechEncoder {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(seconds: f32, sample_rate: u32, channels: usize) -> Vec<i16> {
        let frames = (seconds * sample_rate as f32) as usize;
        (0..frames)
            .flat_map(|i| {
                let t = i as f32 / sample_rate as f32;
                let sample = ((t * 440.0 * std::f32::consts::TAU).sin() * 8000.0) as i16;
                std::iter::repeat_n(sample, channels)
            })
            .collect()
    }

    fn encode_all(encoder: &mut SpeechEncoder, pcm: &[i16], piece: usize) -> Vec<Vec<u8>> {
        let mut units = Vec::new();
        for chunk in pcm.chunks(piece) {
            units.extend(encoder.encode(chunk).unwrap());
        }
        units.extend(encoder.finish().unwrap());
        units
    }

    #[test]
    fn describes_mono_aac_lc_at_the_input_rate() {
        let encoder = SpeechEncoder::new(24_000, 1, 48_000).unwrap();
        // AudioSpecificConfig: object type 2 (LC), rate index 6 (24 kHz), 1 channel.
        assert_eq!(encoder.audio_specific_config(), &[0x13, 0x08]);
        assert_eq!(encoder.frame_samples(), 1024);
    }

    #[test]
    fn every_sample_comes_out_however_the_input_is_split() {
        let pcm = tone(2.0, 24_000, 1);
        let whole = encode_all(
            &mut SpeechEncoder::new(24_000, 1, 48_000).unwrap(),
            &pcm,
            pcm.len(),
        );
        let pieces = encode_all(
            &mut SpeechEncoder::new(24_000, 1, 48_000).unwrap(),
            &pcm,
            777,
        );
        assert_eq!(whole, pieces);
        // The audio, and the encoder's delay (FDK's AAC-LC: 1600 samples)
        // flushed out after it, in whole frames.
        let needed = (pcm.len() + 1600).div_ceil(1024);
        assert!(
            whole.len() >= needed,
            "{} frames, need {needed}",
            whole.len()
        );
        assert!(whole.iter().all(|unit| !unit.is_empty()));
    }

    #[test]
    fn mixes_stereo_down_including_a_frame_split_between_pushes() {
        let stereo = tone(1.0, 24_000, 2);
        let mono = tone(1.0, 24_000, 1);
        // An odd piece size splits interleaved frames across pushes.
        let from_stereo = encode_all(
            &mut SpeechEncoder::new(24_000, 2, 48_000).unwrap(),
            &stereo,
            333,
        );
        let from_mono = encode_all(
            &mut SpeechEncoder::new(24_000, 1, 48_000).unwrap(),
            &mono,
            333,
        );
        assert_eq!(from_stereo, from_mono);
    }

    #[test]
    fn stays_near_its_bit_rate() {
        let pcm = tone(10.0, 24_000, 1);
        let units = encode_all(
            &mut SpeechEncoder::new(24_000, 1, 48_000).unwrap(),
            &pcm,
            4096,
        );
        let bytes: usize = units.iter().map(Vec::len).sum();
        let seconds = units.len() as f64 * 1024.0 / 24_000.0;
        let rate = bytes as f64 * 8.0 / seconds;
        assert!((40_000.0..56_000.0).contains(&rate), "{rate} bits/s");
    }

    #[test]
    fn closing_early_frees_it_and_stops_encoding() {
        let mut encoder = SpeechEncoder::new(24_000, 1, 48_000).unwrap();
        encoder.encode(&tone(0.1, 24_000, 1)).unwrap();
        encoder.close();
        encoder.close();
        assert!(encoder.encode(&[0; 10]).is_err());
        assert!(encoder.finish().unwrap().is_empty());
    }

    #[test]
    fn nothing_is_encoded_after_finishing() {
        let mut encoder = SpeechEncoder::new(24_000, 1, 48_000).unwrap();
        encoder.finish().unwrap();
        assert!(encoder.finish().unwrap().is_empty());
        assert!(encoder.encode(&[0; 10]).is_err());
    }

    #[test]
    fn refuses_rates_aac_has_no_index_for() {
        assert!(SpeechEncoder::new(1_234, 1, 48_000).is_err());
        assert!(SpeechEncoder::new(24_000, 0, 48_000).is_err());
    }
}
