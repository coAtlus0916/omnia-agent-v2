export function bridgeSocketHeartbeatDecision(input: {
  now: number;
  lastPongAt: number;
  lastPingAt: number;
  pingIntervalMs: number;
  pongTimeoutMs: number;
}): { sendPing: boolean; terminate: boolean } {
  const pongAge = input.now - input.lastPongAt;
  const pingAge = input.now - input.lastPingAt;
  const validClock = pongAge >= -5_000 && pingAge >= -5_000;
  return {
    sendPing: validClock && pingAge >= input.pingIntervalMs,
    terminate: !validClock || pongAge >= input.pongTimeoutMs
  };
}
