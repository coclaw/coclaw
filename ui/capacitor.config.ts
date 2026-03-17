import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'net.coclaw.im',
  appName: 'CoClaw',
  webDir: 'dist',
  server: {
    url: 'https://im.coclaw.net',
    cleartext: false,
  },
  plugins: {
    Keyboard: {
      resizeOnFullScreen: true,
    },
  },
};

export default config;
