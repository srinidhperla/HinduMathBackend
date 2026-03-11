const { EventEmitter } = require("events");

const emitter = new EventEmitter();
let socketServer = null;

const setOrderEventSocketServer = (io) => {
  socketServer = io;
};

const emitOrderEvent = (eventName, payload) => {
  const event = {
    eventName,
    payload,
    timestamp: new Date().toISOString(),
  };

  emitter.emit("order-event", event);

  if (socketServer) {
    socketServer.to("admin-orders").emit(eventName, event);
    socketServer.to("admin-orders").emit("order-event", event);
  }
};

const subscribeToOrderEvents = (listener) => {
  emitter.on("order-event", listener);

  return () => {
    emitter.off("order-event", listener);
  };
};

module.exports = {
  setOrderEventSocketServer,
  emitOrderEvent,
  subscribeToOrderEvents,
};
