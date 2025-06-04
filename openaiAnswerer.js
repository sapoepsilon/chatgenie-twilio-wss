import WebSocket from "ws";
import dotenv from "dotenv";

dotenv.config();

const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

export class OpenAIAnswerer {
  constructor(systemMessage, voice = "alloy") {
    this.systemMessage = systemMessage;
    this.voice = voice;
    this.logEventTypes = [
      "response.content.done",
      "rate_limits.updated",
      "response.done",
      "input_audio_buffer.committed",
      "input_audio_buffer.speech_stopped",
      "input_audio_buffer.speech_started",
      "session.created",
    ];
  }

  createWebSocket() {
    return new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );
  }

  createSessionUpdate() {
    return {
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad" },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: {
          model: "whisper-1",
        },
        voice: this.voice,
        instructions: this.systemMessage,
        modalities: ["text", "audio"],
        temperature: 0.8,
      },
    };
  }

  sendSessionUpdate(ws) {
    const sessionUpdate = this.createSessionUpdate();
    console.log("Sending session update:", JSON.stringify(sessionUpdate));
    ws.send(JSON.stringify(sessionUpdate));
  }

  appendAudioBuffer(ws, audioPayload) {
    if (ws.readyState === WebSocket.OPEN) {
      const audioAppend = {
        type: "input_audio_buffer.append",
        audio: audioPayload,
      };
      ws.send(JSON.stringify(audioAppend));
    }
  }

  handleOpenAIMessage(data, streamSid, connection, onTranscript) {
    try {
      const response = JSON.parse(data);
      console.log("response", response);
      
      if (this.logEventTypes.includes(response.type)) {
        console.log(`Received event: ${response.type}`, response);
      }

      if (response.type === "session.updated") {
        console.log("Session updated successfully:", response);
      }

      if (response.type === "response.audio.delta" && response.delta) {
        const audioDelta = {
          event: "media",
          streamSid: streamSid,
          media: {
            payload: Buffer.from(response.delta, "base64").toString("base64"),
          },
        };
        connection.send(JSON.stringify(audioDelta));
      }

      if (response.type === "conversation.item.created") {
        const item = JSON.parse(response.item);
        console.log("response iem data:", item);
      }

      if (response.type === "conversation.item.input_audio_transcription.completed") {
        console.log("User transcription:", response.transcript);
        if (onTranscript) {
          onTranscript(response.transcript, false);
        }
      }

      if (response.type === "response.content_part.done") {
        console.log("assistant response:", response.part);
        if (onTranscript && response.part.transcript) {
          onTranscript(response.part.transcript, true);
        }
      }
    } catch (error) {
      console.error(
        "Error processing OpenAI message:",
        error,
        "Raw message:",
        data
      );
    }
  }
}