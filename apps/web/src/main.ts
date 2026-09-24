import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { appConfig } from './app/app.config';

bootstrapApplication(App, appConfig).catch((err: unknown) => {
  // No logger exists in the browser yet; surface the failure to the global error handler.
  reportError(err);
});
