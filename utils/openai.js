// Placeholder for WebRTC/WebSocket audio forwarding.
// In a full application this would hook into an existing connection.
export function sendAudioStream(stream) {
  if (!stream) return;

  // Example: add tracks to a global RTCPeerConnection if available
  if (window.rtcConnection instanceof RTCPeerConnection) {
    stream.getAudioTracks().forEach(track => {
      window.rtcConnection.addTrack(track, stream);
    });
    return;
  }

  // Fallback: forward audio via WebSocket if one is available
  if (window.audioSocket instanceof WebSocket) {
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = ({ data }) => {
      if (data.size > 0 && window.audioSocket.readyState === WebSocket.OPEN) {
        window.audioSocket.send(data);
      }
    };
    recorder.start(100);
  }
}
