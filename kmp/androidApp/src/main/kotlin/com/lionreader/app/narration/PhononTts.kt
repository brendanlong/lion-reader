package com.lionreader.app.narration

import android.os.Build
import android.os.Process
import com.sun.jna.Callback
import com.sun.jna.Library
import com.sun.jna.Native
import com.sun.jna.Pointer
import com.sun.jna.Structure
import dalvik.system.BaseDexClassLoader
import java.io.File

// Adapted from Gradium's android/PhononTTS.kt (xn-ptts, MIT OR Apache-2.0): the calls of ptts.h
// in libptts_ffi.so, which phonon/build.sh builds, through JNA.

/**
 * A loaded Phonon model (a checkpoint folder: config, tokenizer, weights, `voices/`). Every call
 * blocks: make them off the main thread, from one thread at a time, and [close] it when done.
 */
internal class PhononTts(modelDir: File) : AutoCloseable {
    private var handle: Pointer? =
        lib.ptts_new(modelDir.path, CPU, "en")
            ?: throw IllegalStateException(lib.ptts_last_error(null))
    private var onAudio: (FloatArray) -> Boolean = { true }
    // What onAudio threw: JNA would log it and hand native code `false` (stop), so speak would
    // return as if nothing went wrong.
    private var thrown: Throwable? = null
    // A field, so the callback outlives every call native code holds it for.
    private val onFrame = Lib.FrameFn { pcm, n, _ ->
        try {
            onAudio(pcm.getFloatArray(0, n.toInt()))
        } catch (t: Throwable) {
            thrown = t
            false
        }
    }

    fun setVoice(name: String) = check(lib.ptts_set_voice(open(), name))

    /**
     * Speaks [text], handing [onAudio] each piece as it's made: [SAMPLE_RATE] Hz mono floats in
     * [-1, 1]. [onAudio] returns false to stop early; what it throws, this rethrows.
     */
    fun speak(text: String, onAudio: (FloatArray) -> Boolean) {
        this.onAudio = onAudio
        thrown = null
        val ok = lib.ptts_speak(open(), text, onFrame, null, Timings())
        thrown?.let {
            thrown = null
            throw it
        }
        check(ok)
    }

    override fun close() {
        handle?.let { lib.ptts_free(it) }
        handle = null
    }

    private fun open() = handle ?: throw IllegalStateException("The voice model is closed")

    private fun check(ok: Byte) {
        if (ok.toInt() == 0) throw IllegalStateException(lib.ptts_last_error(handle))
    }

    /**
     * `PttsResult`, which ptts_speak always fills in (it can't be null); `size_t` is 64 bits on
     * both ABIs.
     */
    @Structure.FieldOrder("frames", "samples", "ttfaMs", "totalMs")
    class Timings : Structure() {
        @JvmField var frames: Int = 0
        @JvmField var samples: Long = 0
        @JvmField var ttfaMs: Double = 0.0
        @JvmField var totalMs: Double = 0.0
    }

    /** ptts.h. A C `bool` return is one byte, which JNA's `Boolean` (four) would misread. */
    @Suppress("FunctionName")
    private interface Lib : Library {
        fun ptts_new(dir: String, unit: Int, lang: String): Pointer?

        fun ptts_speak(h: Pointer, text: String, cb: FrameFn, user: Pointer?, out: Timings): Byte

        fun ptts_set_voice(h: Pointer, name: String): Byte

        fun ptts_last_error(h: Pointer?): String?

        fun ptts_free(h: Pointer)

        /** `PttsFrameFn`. `n` is a `size_t`, 64 bits on both ABIs the library is built for. */
        fun interface FrameFn : Callback {
            fun invoke(pcm: Pointer, n: Long, user: Pointer?): Boolean
        }
    }

    companion object {
        /** What Phonon speaks at. */
        const val SAMPLE_RATE = 24_000

        private const val CPU = 0

        private val lib: Lib by lazy {
            // Generation threads, read once when the first model loads. Its default, one per core,
            // is slower on phones that mix fast and slow cores; past two barely helps (a Pixel 4
            // makes 3.0x real time on two, 3.3x on three).
            android.system.Os.setenv("RAYON_NUM_THREADS", "2", true)
            Native.load("ptts_ffi", Lib::class.java)
        }

        /**
         * Whether this device can run it: the app has the library for its ABI (64-bit ARM; x86_64
         * in debug builds, for emulators), and for ARM the CPU has dotprod and fp16, which it's
         * built for (phonon/build.sh). Where they're missing it would kill the process with an
         * illegal instruction, so that's checked before it loads.
         */
        val supported: Boolean by lazy {
            val packaged =
                (PhononTts::class.java.classLoader as? BaseDexClassLoader)?.findLibrary(
                    "ptts_ffi"
                ) != null
            when {
                !packaged || !Process.is64Bit() -> false
                Build.SUPPORTED_64_BIT_ABIS.firstOrNull() == "arm64-v8a" ->
                    armFeatures().containsAll(listOf("asimddp", "fphp", "asimdhp"))
                else -> true
            }
        }

        private fun armFeatures(): Set<String> =
            try {
                File("/proc/cpuinfo")
                    .readLines()
                    .firstOrNull { it.startsWith("Features") }
                    ?.substringAfter(':')
                    ?.trim()
                    ?.split(Regex("\\s+"))
                    ?.toSet()
                    .orEmpty()
            } catch (_: Exception) {
                emptySet()
            }
    }
}
