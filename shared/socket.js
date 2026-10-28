// Every page opens its connection through here: const socket = connectSocket();
//
// WebSocket first. Socket.IO normally starts with HTTP long-polling, which only works if every request of a
// connection reaches the same server process. Vercel runs the server as serverless functions and spreads those
// requests across instances, so connecting often failed or sat for 25 seconds. A WebSocket is one connection,
// so it doesn't have that problem. Polling is kept as the fallback for networks that block WebSockets.
//
// options: anything else for io(), e.g. the game page's auth (see lobby.js)

window.connectSocket = (options = {}) => {
  const socket = io({ transports: ['websocket', 'polling'], tryAllTransports: true, ...options });
  // A message sent to everyone from the admin page (see admin.js), on whatever page they're on
  socket.on('announcement', (message) => {
    if (typeof message === 'string' && window.showAlert) window.showAlert(message, 'info', 10000);
  });
  return socket;
};
