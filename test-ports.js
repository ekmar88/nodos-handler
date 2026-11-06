/**
 * Quick test to try connecting to each Nodos service port
 */
import grpc from '@grpc/grpc-js';
import * as flatbuffers from 'flatbuffers';
import config from './config/default.js';
import { AppEvent } from './sdk/generated/js/nos/app/app-event.js';
import { AppEventUnion } from './sdk/generated/js/nos/app/app-event-union.js';
import { AppConnectionRequest } from './sdk/generated/js/nos/app/app-connection-request.js';
import { SemVer } from './sdk/generated/js/nos/fb/sem-ver.js';

const host = config.nodos.host;
const ports = [50051, 50052, 50053];
const serviceNames = {
  50051: 'Logger',
  50052: 'Editor',
  50053: 'App',
};

// Create a simple connection request
function createConnectionRequest() {
  const builder = new flatbuffers.Builder(1024);
  const semVerOffset = SemVer.createSemVer(builder, 1, 3, 3);
  const appKeyOffset = builder.createString('test-key');
  const appNameOffset = builder.createString('test-app');
  
  AppConnectionRequest.startAppConnectionRequest(builder);
  AppConnectionRequest.addAppKey(builder, appKeyOffset);
  AppConnectionRequest.addAppName(builder, appNameOffset);
  AppConnectionRequest.addUsedApiVersion(builder, semVerOffset);
  AppConnectionRequest.addAppProcessId(builder, BigInt(process.pid));
  const connectionRequestOffset = AppConnectionRequest.endAppConnectionRequest(builder);
  
  AppEvent.startAppEvent(builder);
  AppEvent.addEventType(builder, AppEventUnion.AppConnectionRequest);
  AppEvent.addEvent(builder, connectionRequestOffset);
  const appEventOffset = AppEvent.endAppEvent(builder);
  
  builder.finish(appEventOffset);
  return builder.asByteBuffer();
}

async function testPort(port) {
  return new Promise((resolve) => {
    const serviceName = serviceNames[port] || 'Unknown';
    console.log(`\n=== Testing ${serviceName} on ${host}:${port} ===`);
    
    const channel = new grpc.Channel(`${host}:${port}`, grpc.credentials.createInsecure());
    
    // Try to create a client with the Connect method (bidirectional stream)
    const AppService = grpc.makeGenericClientConstructor({
      'Connect': {
        path: `/nos.app.AppService/Connect`,
        requestStream: true,
        responseStream: true,
        requestSerialize: (buf) => Buffer.from(buf.bytes()),
        responseDeserialize: (buffer) => buffer,
      }
    });
    
    const client = new AppService(`${host}:${port}`, grpc.credentials.createInsecure());
    
    // Try the Connect method
    const call = client.Connect();
    
    call.on('data', (data) => {
      console.log(`  ✅ Received response from ${serviceName}: ${data.length} bytes`);
      call.end();
      channel.close();
      resolve({ port, service: serviceName, success: true, dataLength: data.length });
    });
    
    call.on('error', (err) => {
      console.log(`  ❌ ${serviceName} error: ${err.code} ${err.details}`);
      call.cancel();
      channel.close();
      resolve({ port, service: serviceName, success: false, error: err.details });
    });
    
    call.on('end', () => {
      console.log(`  ⏹️  ${serviceName} stream ended`);
      channel.close();
      resolve({ port, service: serviceName, success: true, ended: true });
    });
    
    call.start();
    call.on('metadata', (md) => {
      console.log(`  📋 ${serviceName} metadata received`);
    });
    
    // Send connection request
    const connReq = createConnectionRequest();
    call.write(connReq);
    console.log(`  📤 Sent connection request to ${serviceName}`);
    
    // Timeout after 5 seconds
    setTimeout(() => {
      console.log(`  ⏰ ${serviceName} timeout`);
      call.cancel();
      channel.close();
      resolve({ port, service: serviceName, success: false, error: 'timeout' });
    }, 5000);
  });
}

async function main() {
  console.log('Testing Nodos service ports...');
  console.log(`Target: ${host}`);
  
  for (const port of ports) {
    const result = await testPort(port);
    console.log(`  Result:`, result);
  }
  
  console.log('\n=== All tests complete ===');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
