import { generateVapidKeys } from '@mmmike/web-push/vapid';
const keys = await generateVapidKeys();
console.log('\nVAPID_PUBLIC_KEY=');
console.log(keys.publicKey);
console.log('\nVAPID_PRIVATE_KEY=');
console.log(keys.privateKey);
console.log('\n請把 Public Key 填入 config.js；Public/Private Key 分別用 wrangler secret put 寫入 Worker。\n');
