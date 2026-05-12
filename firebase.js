import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc,
  doc,
  deleteDoc,
  serverTimestamp,
  onSnapshot,
  query,
  orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

// Replace this object with your Firebase project config.
const firebaseConfig = {
  apiKey: "AIzaSyDlhIXn6OPE19K9w5_VGbMNVvetJH9Mwok",
    authDomain: "notenest-3336e.firebaseapp.com",
    projectId: "notenest-3336e",
    // Use the appspot bucket name for Firebase Storage SDK operations.
    storageBucket: "notenest-3336e.appspot.com",
    messagingSenderId: "247305518428",
    appId: "1:247305518428:web:cad0acfdbdf9aabcc85599"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

export {
  auth,
  db,
  storage,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  collection,
  addDoc,
  doc,
  deleteDoc,
  serverTimestamp,
  onSnapshot,
  query,
  orderBy,
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
};
