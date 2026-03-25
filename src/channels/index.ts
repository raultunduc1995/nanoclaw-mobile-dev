// Channel self-registration barrel file.
// Each import triggers the channel module's registerChannel() call.
// Channels gated by feature flags are conditionally imported.

import { ENABLE_TELEGRAM, ENABLE_WHATSAPP } from '../config.js';

// discord

// gmail

// slack

// telegram
if (ENABLE_TELEGRAM) {
  await import('./telegram/index.js');
}

// whatsapp
if (ENABLE_WHATSAPP) {
  await import('./whatsapp/index.js');
}
