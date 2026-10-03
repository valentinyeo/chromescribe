package org.crolab.chromescribe

import android.app.Activity
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.view.Menu
import android.view.MenuItem
import android.webkit.WebView
import android.widget.Toast
import org.json.JSONObject
import java.util.Locale

/**
 * Renders one transcript's markdown and reads it aloud on request. Reads the
 * cached copy first so it works with no signal; only falls back to the network
 * when nothing is cached.
 */
class ReadActivity : Activity() {

    private lateinit var web: WebView
    private var markdown = ""

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var speaking = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        setContentView(web)

        val id = intent.getStringExtra("id") ?: return finish()
        title = intent.getStringExtra("title") ?: "Transcript"

        // Android's own engine: no key, no network, so read-aloud works in the
        // same offline case the rest of the app is built for.
        tts = TextToSpeech(this) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            tts?.language = Locale.getDefault().takeIf { ttsReady } ?: Locale.US
            @Suppress("OVERRIDE_DEPRECATION")
            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {}
                override fun onError(utteranceId: String?) = finishedSpeaking()
                override fun onDone(utteranceId: String?) {
                    if (utteranceId == LAST) finishedSpeaking()
                }
            })
        }

        val file = Api.contentFile(this, id)
        if (file.exists()) {
            show(file.readText())
        } else {
            Thread {
                try {
                    val md = Api.get("/api/transcript/$id/content")
                    file.writeText(md)
                    runOnUiThread { show(md) }
                } catch (e: Exception) {
                    runOnUiThread {
                        Toast.makeText(this, "Not cached and offline", Toast.LENGTH_LONG).show()
                        finish()
                    }
                }
            }.start()
        }
    }

    private fun show(md: String) {
        markdown = md
        val template = assets.open("reader.html").bufferedReader().use { it.readText() }
        val html = template.replace("__MARKDOWN__", JSONObject.quote(md))
        web.loadDataWithBaseURL("file:///android_asset/", html, "text/html", "utf-8", null)
    }

    // --- read aloud -----------------------------------------------------

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(0, MENU_SPEAK, 0, if (speaking) "Stop" else "Read aloud")
            .setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        if (item.itemId != MENU_SPEAK) return super.onOptionsItemSelected(item)
        if (speaking) stopSpeaking() else startSpeaking()
        return true
    }

    private fun startSpeaking() {
        if (!ttsReady) {
            Toast.makeText(this, "Text-to-speech engine not ready", Toast.LENGTH_SHORT).show()
            return
        }
        val chunks = chunk(spokenText(markdown))
        if (chunks.isEmpty()) {
            Toast.makeText(this, "Nothing to read", Toast.LENGTH_SHORT).show()
            return
        }
        speaking = true
        invalidateOptionsMenu()
        chunks.forEachIndexed { i, text ->
            val mode = if (i == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
            val id = if (i == chunks.lastIndex) LAST else i.toString()
            tts?.speak(text, mode, null, id)
        }
    }

    private fun stopSpeaking() {
        tts?.stop()
        finishedSpeaking()
    }

    private fun finishedSpeaking() = runOnUiThread {
        speaking = false
        invalidateOptionsMenu()
    }

    /**
     * The summary only — the full transcript below it is the raw thing the
     * summary exists to replace, and nobody wants 40 minutes of it read back.
     * Markdown markers are stripped so the engine doesn't pronounce them.
     */
    private fun spokenText(md: String): String = md
        .substringBefore("\n## Full Transcript")
        .substringBefore("\n## Full Article")
        .lineSequence()
        .filterNot { it.startsWith("**Source:**") || it.startsWith("**Date:**") || it.startsWith("**Type:**") }
        .map { line ->
            line.replace(Regex("^#{1,6}\\s*"), "")
                .replace(Regex("^[>\\-*]\\s+"), "")
                .replace(Regex("https?://\\S+"), "")
                // Transcript citations like [2:29] would be read out digit by digit.
                .replace(Regex("\\s*\\[\\d+:\\d+(?::\\d+)?\\]"), "")
                .replace("**", "")
                .replace("`", "")
                .replace("---", "")
        }
        .joinToString("\n")
        .replace(Regex("\n{3,}"), "\n\n")
        // Spoken as "T L semicolon D R" otherwise.
        .replace("TL;DR", "Key points")
        .trim()

    /** TextToSpeech rejects anything over ~4000 chars, so split on sentences. */
    private fun chunk(text: String, max: Int = 3000): List<String> {
        if (text.isBlank()) return emptyList()
        val out = mutableListOf<String>()
        val current = StringBuilder()
        for (sentence in text.split(Regex("(?<=[.!?])\\s+|\n\n"))) {
            if (current.isNotEmpty() && current.length + sentence.length > max) {
                out.add(current.toString())
                current.setLength(0)
            }
            if (sentence.length > max) {
                sentence.chunked(max).forEach { out.add(it) }
            } else {
                if (current.isNotEmpty()) current.append(' ')
                current.append(sentence)
            }
        }
        if (current.isNotEmpty()) out.add(current.toString())
        return out.filter { it.isNotBlank() }
    }

    override fun onDestroy() {
        tts?.stop()
        tts?.shutdown()
        tts = null
        super.onDestroy()
    }

    private companion object {
        const val MENU_SPEAK = 1
        const val LAST = "last"
    }
}
