import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

/**
 * A service worker only looks for a new build when something asks it to, and a
 * phone whose tab is never closed may not ask for days — which is how a device
 * ends up still running last week's app long after the deploy went out. We hit
 * exactly that: the fix for a dead-looking button was deployed and the phone
 * kept serving the broken bundle until it was force-closed by hand.
 *
 * "Force-close the app" is not a procedure anyone in a wash yard should need to
 * know, so ask on every foreground, on reconnect, and hourly while it sits
 * open. The worker is built with skipWaiting and clientsClaim (see
 * vite.config.ts), so a newer one takes over as soon as it is found — and the
 * page it took over from is still running the old bundle, which is what the
 * reload is for.
 *
 * Adapted from the barbershop app, which hit the same thing on its first day.
 */
function keepAppUpToDate(): void {
  if (!("serviceWorker" in navigator)) return;

  // Only true when this page was already being served by a worker. A
  // first-ever install also changes the controller, and reloading the app out
  // from under someone who has only just opened it would be pure noise.
  const wasControlled = Boolean(navigator.serviceWorker.controller);
  let reloading = false;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!wasControlled || reloading) return;
    reloading = true;
    window.location.reload();
  });

  void navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
    .then((registration) => {
      const check = () => {
        if (document.visibilityState === "visible") void registration.update();
      };
      document.addEventListener("visibilitychange", check);
      window.addEventListener("online", check);
      window.setInterval(check, 60 * 60 * 1000);
    })
    .catch(() => {
      // No worker costs offline mode, not the app: the wash screen still works
      // and the queue still lives in IndexedDB. Nothing to say here.
    });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

keepAppUpToDate();
