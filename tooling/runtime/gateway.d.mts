export interface GatewayRequest {
  namespace: string
  method: string
  args: Record<string, unknown>
  signal?: AbortSignal
}

export interface OwnerGateway {
  invoke(request: GatewayRequest): Promise<unknown>
  stream(request: GatewayRequest): Promise<AsyncIterable<unknown>>
}

export interface HostGatewayLike {
  invoke(request: GatewayRequest & { peer: unknown }): Promise<unknown>
  stream(request: GatewayRequest & { peer: unknown }): Promise<AsyncIterable<unknown>>
}

export interface ConnectionLike {
  createPeer(options: { principal: { kind: 'owner' } }): unknown
}

export declare function ownerGateway(gateway: HostGatewayLike, connection: ConnectionLike): OwnerGateway
