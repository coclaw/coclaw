import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'net.coclaw.app',
  appName: 'CoClaw',
  webDir: 'dist',
  server: {
    url: 'https://im.coclaw.net',
    cleartext: false,
  },
};

export default config;
