// plugins/protocol.ts — host-side mirror of `src/plugin-sdk/protocol.ts`.
//
// We re-export the same shapes so the host imports its own copy rather
// than reaching into the SDK package. Both files MUST stay structurally
// identical — when one changes, change both in the same patch and run
// `protocol.test.ts` which asserts the round-trip is loss-less.
//
// Why two copies instead of one shared module: the SDK is an external
// package plugin authors install. Coupling the host to its public API
// directly would force every host change to bump the SDK's published
// version. Mirroring keeps the host free to evolve internal helpers
// without breaking plugins that use older SDK builds.

export type {
  PluginToHostMessage,
  HostToPluginMessage,
  HandshakeRequest,
  HandshakeAck,
  RpcRequest,
  RpcResponse,
  SubscribeRequest,
  UnsubscribeRequest,
  EventPush,
  CloseMessage,
} from '@revyme/plugin-sdk/protocol';
export { PROTOCOL_VERSION, HOST_NAME } from '@revyme/plugin-sdk/protocol';
