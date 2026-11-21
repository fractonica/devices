// Plain constants of the protocol, with no dependency, so a browser bundle takes them without the Zod schemas
// (@fractonica/protocol/client). types.ts and ws.ts re-export them.

/** `"broadcast"`: the reserved alias message_send and binding targets use for every node (09 §9.4). */
export const BROADCAST_ALIAS = 'broadcast';

/** The request header naming the client (lower case, as Node delivers headers). */
export const CLIENT_HEADER = 'x-fr-client';

/**
 * The request header that names the hub an op runs on (design multi-hub-m2 §7.2): `X-Fr-At: <hub name>`, beside the
 * op's input and never in it (some ops have an input of their own called `at`). `fr --at <hub> <command>` sends it.
 */
export const AT_HEADER = 'x-fr-at';

/**
 * The protocol's name and path (port 7420, 08 §8.10). The name is not a WebSocket subprotocol: `/` is not
 * an RFC 7230 token character, so `new WebSocket(url, 'fr-ws/1')` throws. Clients request none; the path
 * and `hello.v` identify fr-ws/1.
 */
export const WS_PROTOCOL = 'fr-ws/1';
export const WS_PATH = '/ws';
