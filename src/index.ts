import { config } from './config.js';
import { createApp } from './app.js';

createApp().listen(config.port, () => console.log(`API em http://localhost:${config.port}`));
