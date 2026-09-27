import {SocksClient} from 'socks'
import {randomUUID} from 'node:crypto'
import {validateProxy} from '../../resources/proxyStore.js'

export function proxyConnect({proxy,incarnationId,host,port=25565,connect=SocksClient.createConnection,onDiagnostic=()=>{}}){
 if(!proxy||!proxy.reservationId||!proxy.proxyId||proxy.incarnationId!==incarnationId)throw new Error('AUTHORIZED_PROXY_REQUIRED')
 const config=validateProxy({...proxy,active:true})
 if(typeof host!=='string'||!host||!Number.isInteger(port)||port<1||port>65535)throw new Error('INVALID_MINECRAFT_DESTINATION')
 return client=>{
  let closed=false,socket
  const connectionId=randomUUID(),report=code=>onDiagnostic(code,connectionId)
  client.once('end',()=>{closed=true;socket?.destroy();report('PROXY_TRANSPORT_CLOSED')})
  void connect({proxy:{host:config.host,port:config.port,type:5,userId:config.username,password:config.password},command:'connect',destination:{host,port},timeout:15000}).then(result=>{
   socket=result.socket
   if(closed){socket.destroy();return}
   // Never forward a third-party error object: it may contain authenticated options.
   socket.on('error',()=>report('PROXY_TRANSPORT_FAILED'))
   socket.once('close',()=>report('PROXY_TRANSPORT_CLOSED'))
   client.setSocket(socket);report('PROXY_TRANSPORT_CONNECTED');client.emit('connect')
  }).catch(error=>{
   const code=/auth/i.test(String(error?.message))?'PROXY_AUTHENTICATION_FAILED':'PROXY_CONNECTION_FAILED'
   report(code);if(!closed){client.emit('error',new Error(code));client.emit('end',code)}
  })
 }
}
