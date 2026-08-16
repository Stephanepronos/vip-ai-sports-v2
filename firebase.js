console.log("🔥 APP LOADING...");

/* ================= FIREBASE ================= */
const firebaseConfig = {
    apiKey: "AIzaSyCZXO3lcRCbQyP3vMIruED22RlXia5bkt8",
    authDomain: "vip-pronostics.firebaseapp.com",
    projectId: "vip-pronostics",
    storageBucket: "vip-pronostics.appspot.com",
    messagingSenderId: "27928000277",
    appId: "1:27928000277:web:2bc67e62934e10319b9b1c"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();

window.auth = auth;
window.db = db;

/* ================= AUTH ================= */
const Auth = {

    getUser: async () => {
        const user = auth.currentUser;
        if (!user) return null;

        const snap = await db.collection("users").doc(user.uid).get();
        if (!snap.exists) return null;

        return snap.data();
    },

    logout: async () => {
        await auth.signOut();
        window.location.href = "login.html";
    },

    isVip: async () => {
        const u = await Auth.getUser();
        return u && u.role === "vip" && u.vipActive === true;
    }
};

window.Auth = Auth;

/* ================= ENGINE ================= */
const Engine = (() => {

    const teams = {
        PSG: 85,
        "Real Madrid": 90,
        Barcelona: 88,
        Chelsea: 78,
        Arsenal: 82,
        Bayern: 91,
        Inter: 83,
        Juventus: 80,
        "Man City": 91,
        Liverpool: 87
    };

    function match() {
        const keys = Object.keys(teams);

        let home = keys[Math.floor(Math.random() * keys.length)];
        let away = keys[Math.floor(Math.random() * keys.length)];

        while (home === away) {
            away = keys[Math.floor(Math.random() * keys.length)];
        }

        return { home, away };
    }

    function confidence(h, a) {
        const hS = teams[h] || 75;
        const aS = teams[a] || 75;

        let score = 65 + (hS - aS) * 0.7;
        score += (Math.random() * 4 - 2);

        return Math.max(50, Math.min(95, Math.round(score)));
    }

    function free(conf) {
        if (conf >= 80) return "1X ✔";
        if (conf >= 70) return "OVER 1.5 ✔";
        return "DOUBLE CHANCE ✔";
    }

    async function generate(type = "free", count = 3) {

        const results = [];

        for (let i = 0; i < count; i++) {

            const m = match();
            const conf = confidence(m.home, m.away);

            results.push({
                match: `${m.home} vs ${m.away}`,
                confidence: conf,
                prediction: free(conf)
            });
        }

        return results;
    }

    return { generate };

})();

window.Engine = Engine;

console.log("🔥 APP READY");