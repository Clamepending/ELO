// Shared Google sign-in (Google Identity Services token flow) for the Google
// Photos and Google Calendar connectors. Tokens live only in this page.

import { GOOGLE_CLIENT_ID } from './config.js';

const GIS_URL = 'https://accounts.google.com/gsi/client';

export const isConfigured = () => Boolean(GOOGLE_CLIENT_ID);

let gisPromise = null;
function loadGis() {
  return (gisPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_URL;
    s.onload = () => resolve(window.google.accounts.oauth2);
    s.onerror = () => { gisPromise = null; reject(new Error('Could not load Google sign-in')); };
    document.head.append(s);
  }));
}

// Load the sign-in library at page load, so the click that requests a token
// opens its popup synchronously and isn't blocked.
export function preloadSignIn() { return loadGis().catch(() => {}); }

export function getToken(scope) {
  return loadGis().then((oauth2) => new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope,
      callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r.access_token)),
      error_callback: (e) => reject(new Error(e.message || e.type || 'Sign-in cancelled')),
    });
    client.requestAccessToken();
  }));
}
