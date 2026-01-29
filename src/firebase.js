import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCrolaCYxIKo-DOk_ACaIbcVzP1NJUlbDQ",
  authDomain: "bag-tag-tracker-90fe1.firebaseapp.com",
  projectId: "bag-tag-tracker-90fe1",
  storageBucket: "bag-tag-tracker-90fe1.firebasestorage.app",
  messagingSenderId: "561051760219",
  appId: "1:561051760219:web:48a573a098ec7a5a67317e",
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);

export async function ensureAnonAuth() {
  if (!auth.currentUser) {
    await signInAnonymously(auth);
  }
}
