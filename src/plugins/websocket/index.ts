import { createPlugin } from '@/utils';
import { backend } from './main';

export type WebsocketPluginConfig = {
  enabled: boolean;
};

export default createPlugin({
  name: () => 'WebSocket',
  description: () => '',
  restartNeeded: true,
  config: {
    enabled: false,
  } as WebsocketPluginConfig,
  backend,
});
