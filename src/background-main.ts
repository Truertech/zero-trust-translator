/** The service worker entry (#3797): registers the listeners of `background.ts`. */
import { installBackground } from './background';

installBackground(chrome as unknown as Parameters<typeof installBackground>[0]);