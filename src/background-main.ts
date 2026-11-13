/** The service worker entry: registers the listeners of `background.ts`. */
import { installBackground } from './background';

installBackground(chrome as unknown as Parameters<typeof installBackground>[0]);