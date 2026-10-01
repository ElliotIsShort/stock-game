"use client";

import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore, type Firestore } from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions, type Functions } from "firebase/functions";

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const useEmulators = process.env.NEXT_PUBLIC_USE_EMULATORS === "true";

export const firebaseConfigured = Boolean(config.projectId && (config.apiKey || useEmulators));

interface Clients {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  functions: Functions;
}

let clients: Clients | null = null;

/** Lazily initialise Firebase (browser only; the static build never touches it). */
export function fb(): Clients {
  if (clients) return clients;
  const app = getApps().length ? getApp() : initializeApp({ ...config, apiKey: config.apiKey || "demo-key" });
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, process.env.NEXT_PUBLIC_FUNCTIONS_REGION || "europe-west2");
  if (useEmulators) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8180);
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  }
  clients = { app, auth, db, functions };
  return clients;
}
