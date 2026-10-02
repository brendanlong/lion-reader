//! N-API bindings for the speech encoder (`lion-reader-speech-encoder-core`).
//!
//! Synchronous: each call encodes the fraction of a second of audio a provider
//! has just streamed, which takes well under a millisecond, so handing it to
//! the thread pool would cost more than it saves.

#[macro_use]
extern crate napi_derive;

use lion_reader_speech_encoder_core as core;
use napi::bindgen_prelude::Buffer;
use napi::{Error, Result};

fn js_error(error: core::EncodeError) -> Error {
    Error::from_reason(error.to_string())
}

/// Encodes one stream of 16-bit little-endian PCM to mono AAC-LC access units.
#[napi]
pub struct SpeechEncoder {
    inner: core::SpeechEncoder,
    /// The odd byte of the last push, until its sample's other half arrives.
    odd_byte: Option<u8>,
}

#[napi]
impl SpeechEncoder {
    #[napi(constructor)]
    pub fn new(sample_rate: u32, channels: u32, bit_rate: u32) -> Result<Self> {
        Ok(SpeechEncoder {
            inner: core::SpeechEncoder::new(sample_rate, channels, bit_rate).map_err(js_error)?,
            odd_byte: None,
        })
    }

    /// The MPEG-4 AudioSpecificConfig, for the MP4 sample description.
    #[napi(getter)]
    pub fn audio_specific_config(&self) -> Buffer {
        self.inner.audio_specific_config().to_vec().into()
    }

    /// Samples per access unit.
    #[napi(getter)]
    pub fn frame_samples(&self) -> u32 {
        self.inner.frame_samples() as u32
    }

    /// Encodes more PCM bytes (any length): the access units completed.
    #[napi]
    pub fn encode(&mut self, pcm: Buffer) -> Result<Vec<Buffer>> {
        let mut bytes: &[u8] = &pcm;
        let mut samples = Vec::with_capacity(bytes.len() / 2 + 1);
        if let (Some(low), Some((&high, rest))) = (self.odd_byte, bytes.split_first()) {
            samples.push(i16::from_le_bytes([low, high]));
            self.odd_byte = None;
            bytes = rest;
        }
        let pairs = bytes.chunks_exact(2);
        if let [odd] = pairs.remainder() {
            self.odd_byte = Some(*odd);
        }
        samples.extend(pairs.map(|pair| i16::from_le_bytes([pair[0], pair[1]])));
        let units = self.inner.encode(&samples).map_err(js_error)?;
        Ok(units.into_iter().map(Buffer::from).collect())
    }

    /// Frees the encoder now rather than at garbage collection; encoding after
    /// this fails. [`finish`](Self::finish) does it too.
    #[napi]
    pub fn close(&mut self) {
        self.inner.close();
    }

    /// Encodes what's left and flushes the encoder: the final access units.
    /// Frees the encoder.
    #[napi]
    pub fn finish(&mut self) -> Result<Vec<Buffer>> {
        let units = self.inner.finish().map_err(js_error)?;
        Ok(units.into_iter().map(Buffer::from).collect())
    }
}
