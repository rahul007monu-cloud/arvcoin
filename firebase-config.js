/* =========================================================
   arvcoin — Firebase config

   Where these come from:
     console.firebase.google.com -> your project -> Project settings
     -> "Your apps" (Web </>) -> SDK setup and configuration

   NOTE: these values are PUBLIC by design. Every Firebase web app ships
   them in its frontend — they identify the project, they do not grant
   access. Access is controlled by firestore.rules and Firebase Auth.
   The value that must never appear here is a service account key.

   Full setup walkthrough: SETUP.md
   ========================================================= */
window.ARV_FIREBASE_CONFIG = {
  apiKey: "AIzaSyB1cFGZ_Ck08MZ6rMDlCb-3LFVHuIxGQjU",
  authDomain: "arvcoin-fbd29.firebaseapp.com",
  projectId: "arvcoin-fbd29",
  storageBucket: "arvcoin-fbd29.firebasestorage.app",
  messagingSenderId: "44275546012",
  appId: "1:44275546012:web:779ac217d33d4c83bcfa59",
  measurementId: "G-2WVXD25RFN"
};
