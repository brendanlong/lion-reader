package com.lionreader.shared.settings

import com.lionreader.shared.api.CloudVoice
import com.lionreader.shared.api.VoiceModel
import com.lionreader.shared.api.VoiceModels
import kotlin.test.Test
import kotlin.test.assertEquals

class NarrationEngineTest {
    private val offered =
        VoiceModels(
            listOf(
                VoiceModel(
                    "kokoro",
                    "Kokoro",
                    listOf(CloudVoice("heart", "Heart")),
                    defaultVoice = "heart",
                    provider = "p",
                    providerDisplayName = "P",
                )
            ),
            defaultModelId = "kokoro",
        )
    private val none = VoiceModels(emptyList(), defaultModelId = "")

    @Test
    fun cloudWhileTheServerOffersCloudVoicesOrHasntSaid() {
        assertEquals(NarrationEngine.CLOUD, NarrationEngine.CLOUD.inUse(offered))
        assertEquals(NarrationEngine.CLOUD, NarrationEngine.CLOUD.inUse(null))
    }

    @Test
    fun theDevicesVoicesWhenTheServerOffersNone() {
        assertEquals(NarrationEngine.DEVICE, NarrationEngine.CLOUD.inUse(none))
        assertEquals(NarrationEngine.ENHANCED, NarrationEngine.ENHANCED.inUse(none))
    }
}
