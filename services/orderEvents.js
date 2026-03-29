const { EventEmitter } = require("events");

const emitter = new EventEmitter();
let socketServer = null;
const normalizeScope = (scope) =>
  String(scope || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
const PUBLIC_SCOPES = new Set([
  "products",
  "inventory",
  "settings",
  "delivery",
  "delivery-settings",
  "delivery-timing",
]);

const toId = (value) => {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value?.toString === "function") {
    return value.toString();
  }

  return "";
};

const setOrderEventSocketServer = (io) => {
  socketServer = io;
};

const emitSiteDataUpdated = (scope, payload = {}) => {
  if (!socketServer) {
    return;
  }

  const normalizedScope = normalizeScope(scope || "general");

  socketServer.emit("site-data-updated", {
    scope: normalizedScope,
    payload,
    timestamp: new Date().toISOString(),
  });
};

const emitAdminDataUpdated = (scope, payload = {}) => {
  if (!socketServer) {
    return;
  }

  const normalizedScope = normalizeScope(scope || "general");

  socketServer.to("admin-orders").emit("admin-data-updated", {
    scope: normalizedScope,
    payload,
    timestamp: new Date().toISOString(),
  });

  if (PUBLIC_SCOPES.has(normalizedScope)) {
    emitSiteDataUpdated(normalizedScope, payload);
  }
};

const emitOrderEvent = (eventName, payload) => {
  const event = {
    eventName,
    payload,
    timestamp: new Date().toISOString(),
  };

  emitter.emit("order-event", event);
  emitAdminDataUpdated("orders", { eventName });

  if (socketServer) {
    socketServer.to("admin-orders").emit(eventName, event);
    socketServer.to("admin-orders").emit("order-event", event);

    const userId = toId(payload?.user?._id || payload?.user);
    if (userId) {
      socketServer.to(`user-orders:${userId}`).emit(eventName, event);
      socketServer.to(`user-orders:${userId}`).emit("order-event", event);
    }

    const deliveryPartnerId = toId(
      payload?.assignedDeliveryPartner?._id || payload?.assignedDeliveryPartner,
    );
    if (deliveryPartnerId) {
      socketServer
        .to(`delivery-orders:${deliveryPartnerId}`)
        .emit(eventName, event);
      socketServer
        .to(`delivery-orders:${deliveryPartnerId}`)
        .emit("order-event", event);
    }
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
  emitAdminDataUpdated,
  subscribeToOrderEvents,
  emitSiteDataUpdated,
};
