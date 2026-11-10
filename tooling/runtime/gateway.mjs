/**
 * DSH 0.2.1 起，宿主网关的每次调用都要带调用者 Peer（身份加生命周期），Peer 释放后调用一律被拒。
 * 进程内插件用连接服务建一个本机所有者 Peer：权限和网页端登录的本机用户一样，归读取连接服务的 Context 所有，插件卸载时随之释放。
 */
export function ownerGateway(gateway, connection) {
  const peer = connection.createPeer({ principal: { kind: 'owner' } })
  return {
    invoke: request => gateway.invoke({ ...request, peer }),
    stream: request => gateway.stream({ ...request, peer }),
  }
}
