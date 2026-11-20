// Where the E2E servers listen. Override with PB_E2E_WEB_PORT / PB_E2E_STATION_PORT when these are taken.
export const WEB_PORT = Number(process.env.PB_E2E_WEB_PORT ?? 4180);
export const STATION_PORT = Number(process.env.PB_E2E_STATION_PORT ?? 4181);
export const STATION_URL = `ws://localhost:${STATION_PORT}`;
// The empty-Flow fixture (engine/tests/sdk-station/empty-main.cpp), started by its spec:
// one with a station object and its linked block, one with nothing.
export const STATION_STATION_PORT = Number(process.env.PB_E2E_STATION_STATION_PORT ?? 4182);
export const EMPTY_STATION_PORT = Number(process.env.PB_E2E_EMPTY_STATION_PORT ?? 4183);
