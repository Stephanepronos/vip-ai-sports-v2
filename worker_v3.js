export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return corsResponse(null, 204, origin);
    }

    try {
      if (url.pathname === "/" || url.pathname === "/health") {
        return corsResponse({
          status: "ONLINE",
          engine: "VIP AI ENGINE",
          version: "2.0",
          firebase: env.FIREBASE_PROJECT_ID ? "CONFIGURED" : "MISSING",
          routes: ["/health", "/generate", "/update", "/fixtures"]
        }, 200, origin);
      }

      
      if (url.pathname === "/fixtures") {
        if (request.method !== "GET") {
          return corsResponse(
            { error: "Use GET /fixtures" },
            405,
            origin
          );
        }

        if (!env.FOOTBALL_DATA_TOKEN) {
          throw new Error("FOOTBALL_DATA_TOKEN is not configured");
        }

        const competitions = {
          PL: "Premier League",
          FL1: "Ligue 1",
          PD: "La Liga",
          BL1: "Bundesliga",
          SA: "Serie A",
          DED: "Eredivisie",
          PPL: "Primeira Liga",
          BSA: "Brasileirão"
        };

        const urlFrom = url.searchParams.get("dateFrom");
        const urlTo = url.searchParams.get("dateTo");

        const today = new Date();
        const defaultFrom = today.toISOString().slice(0, 10);

        const future = new Date(today);
        future.setDate(future.getDate() + 14);
        const defaultTo = future.toISOString().slice(0, 10);

        const dateFrom = urlFrom || defaultFrom;
        const dateTo = urlTo || defaultTo;

        const results = [];
        const errors = [];

        for (const [code, name] of Object.entries(competitions)) {
          try {
            const apiUrl =
              `https://api.football-data.org/v4/competitions/${code}/matches` +
              `?status=SCHEDULED&dateFrom=${encodeURIComponent(dateFrom)}` +
              `&dateTo=${encodeURIComponent(dateTo)}`;

            const response = await fetch(apiUrl, {
              method: "GET",
              headers: {
                "X-Auth-Token": env.FOOTBALL_DATA_TOKEN
              }
            });

            const text = await response.text();

            if (!response.ok) {
              errors.push({
                competition: code,
                name,
                status: response.status,
                error: text.slice(0, 500)
              });
              continue;
            }

            const data = JSON.parse(text);

            for (const match of data.matches || []) {
              results.push({
                competition: code,
                competitionName: name,
                matchId: match.id,
                date: match.utcDate,
                status: match.status,
                matchday: match.matchday || null,
                homeTeam: match.homeTeam?.shortName ||
                  match.homeTeam?.name || "",
                awayTeam: match.awayTeam?.shortName ||
                  match.awayTeam?.name || "",
                homeTeamId: match.homeTeam?.id || null,
                awayTeamId: match.awayTeam?.id || null,
                homeCrest: match.homeTeam?.crest || "",
                awayCrest: match.awayTeam?.crest || ""
              });
            }
          } catch (error) {
            errors.push({
              competition: code,
              name,
              error: error instanceof Error
                ? error.message
                : "Unknown error"
            });
          }
        }

        results.sort(
          (a, b) =>
            new Date(a.date).getTime() -
            new Date(b.date).getTime()
        );

        return corsResponse({
          status: "SUCCESS",
          source: "football-data.org",
          dateFrom,
          dateTo,
          competitions,
          count: results.length,
          matches: results,
          errors
        }, 200, origin);
      }

      if (url.pathname === "/generate") {
        if (request.method !== "POST") {
          return corsResponse({ error: "Use POST /generate" }, 405, origin);
        }

        const admin = await requireFirebaseAdmin(request, env);
        const body = await request.json();

        if (Array.isArray(body.matches)) {
          if (body.matches.length < 1) {
            throw new Error("matches must contain at least one match");
          }

          const analyses = body.matches.map(analyzeMatch);
          analyses.sort((a, b) => b.confidence - a.confidence);

          const best = analyses.slice(0, 3);

          const formatPrediction = (p) =>
            `${p.match} → ${p.prediction} (${p.confidence}%)`;

          const predictions = {
            aiMatch1: formatPrediction(best[0]),
            aiMatch2: formatPrediction(best[1]),
            aiMatch3: formatPrediction(best[2]),
            coupon1: `${best[0].match} + ${best[1].match}`,
            coupon2: `${best[1].match} + ${best[2].match}`
          };

          const firestore = await archiveAndPublishFirestore(
            env,
            predictions,
            best,
            admin.email
          );

          return corsResponse({
            status: "SUCCESS",
            engine: "VIP AI ENGINE",
            version: "2.0",
            count: analyses.length,
            best,
            analyses,
            firestore
          }, 200, origin);
        }

        return corsResponse({
          status: "SUCCESS",
          engine: "VIP AI ENGINE",
          version: "2.0",
          analysis: analyzeMatch(body)
        }, 200, origin);
      }

      if (url.pathname === "/update") {
        if (request.method !== "POST") {
          return corsResponse({ error: "Use POST /update" }, 405, origin);
        }

        requireAdmin(request, env);

        const body = await request.json();
        const predictions = normalizePredictions(body);

        const result = await updateFirestore(env, predictions);

        return corsResponse({
          status: "SUCCESS",
          message: "predictions/current updated",
          firestore: result,
          predictions
        }, 200, origin);
      }

      return corsResponse({
        status: "ERROR",
        error: "Route not found"
      }, 404, origin);

    } catch (error) {
      return corsResponse({
        status: "ERROR",
        message: error instanceof Error ? error.message : "Unknown error"
      }, 400, origin);
    }
  }
};

function corsResponse(data, status, origin) {
  const headers = {
    "Content-Type": "application/json; charset=UTF-8",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization"
  };

  return new Response(
    data === null ? null : JSON.stringify(data),
    { status, headers }
  );
}

function requireAdmin(request, env) {
  if (!env.ADMIN_API_SECRET) {
    throw new Error("ADMIN_API_SECRET is not configured");
  }

  const auth = request.headers.get("Authorization") || "";
  const expected = `Bearer ${env.ADMIN_API_SECRET}`;

  if (auth !== expected) {
    throw new Error("Unauthorized");
  }
}


async function requireFirebaseAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";

  if (!auth.startsWith("Bearer ")) {
    throw new Error("Firebase ID token manquant");
  }

  const idToken = auth.slice(7).trim();

  if (!env.FIREBASE_WEB_API_KEY) {
    throw new Error("FIREBASE_WEB_API_KEY is not configured");
  }

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        idToken
      })
    }
  );

  const data = await response.json();

  if (!response.ok || !Array.isArray(data.users) || !data.users[0]) {
    throw new Error("Firebase ID token invalide ou expiré");
  }

  const firebaseUser = data.users[0];
  const uid = firebaseUser.localId;

  const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const token = await createAccessToken(serviceAccount);

  const userEndpoint =
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}` +
    `/databases/(default)/documents/users/${encodeURIComponent(uid)}`;

  const userResponse = await fetch(userEndpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const userText = await userResponse.text();

  if (!userResponse.ok) {
    throw new Error(`Impossible de vérifier le rôle admin: ${userText}`);
  }

  const userDoc = JSON.parse(userText);
  const role = userDoc.fields?.role?.stringValue || "";

  if (role !== "admin") {
    throw new Error("Accès administrateur refusé");
  }

  return {
    uid,
    email: firebaseUser.email || ""
  };
}

async function archiveAndPublishFirestore(
  env,
  predictions,
  analyses,
  adminEmail
) {
  if (!env.FIREBASE_PROJECT_ID) {
    throw new Error("FIREBASE_PROJECT_ID is not configured");
  }

  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not configured");
  }

  const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const token = await createAccessToken(serviceAccount);

  const base =
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}` +
    `/databases/(default)/documents`;

  const currentEndpoint = `${base}/predictions/current`;

  // =========================
  // ARCHIVE CURRENT
  // =========================

  const currentResponse = await fetch(currentEndpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (currentResponse.ok) {
    const currentDoc = await currentResponse.json();

    const historyFields = {
      ...(currentDoc.fields || {}),
      archivedAt: firestoreInteger(Date.now()),
      archivedBy: firestoreString(adminEmail || "admin")
    };

    const historyResponse = await fetch(
      `${base}/predictions_history`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          fields: historyFields
        })
      }
    );

    const historyText = await historyResponse.text();

    if (!historyResponse.ok) {
      throw new Error(
        `Firestore archive error ${historyResponse.status}: ${historyText}`
      );
    }
  } else if (currentResponse.status !== 404) {
    const currentText = await currentResponse.text();

    throw new Error(
      `Firestore read error ${currentResponse.status}: ${currentText}`
    );
  }

  // =========================
  // NEW CURRENT PREDICTIONS
  // =========================

  const updatedAt = Date.now();

  const currentFields = {
    aiMatch1: firestoreString(predictions.aiMatch1),
    aiMatch2: firestoreString(predictions.aiMatch2),
    aiMatch3: firestoreString(predictions.aiMatch3),
    coupon1: firestoreString(predictions.coupon1),
    coupon2: firestoreString(predictions.coupon2),
    updatedAt: firestoreInteger(updatedAt)
  };

  const currentWrite = await fetch(currentEndpoint, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      fields: currentFields
    })
  });

  const currentText = await currentWrite.text();

  if (!currentWrite.ok) {
    throw new Error(
      `Firestore current error ${currentWrite.status}: ${currentText}`
    );
  }

  // =========================
  // AI PREDICTIONS HISTORY
  // =========================

  const total = analyses.reduce(
    (sum, item) => sum + Number(item.confidence || 0),
    0
  );

  const averageConfidence = Math.round(
    total / Math.max(analyses.length, 1)
  );

  const aiFields = {
    model: firestoreString("VIP_AI_ENGINE_V2"),
    type: firestoreString("vip"),
    averageConfidence: firestoreInteger(averageConfidence),
    status: firestoreString("ACTIVE"),
    predictions: firestoreArray(
      analyses.map(item =>
        firestoreMap({
          match: firestoreString(item.match),
          prediction: firestoreString(item.prediction),
          confidence: firestoreInteger(item.confidence),
          risk: firestoreString(item.risk),
          recommendation: firestoreString(item.recommendation)
        })
      )
    ),
    createdAt: firestoreInteger(updatedAt)
  };

  const aiWrite = await fetch(
    `${base}/ai_predictions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        fields: aiFields
      })
    }
  );

  const aiText = await aiWrite.text();

  if (!aiWrite.ok) {
    throw new Error(
      `Firestore ai_predictions error ${aiWrite.status}: ${aiText}`
    );
  }

  return {
    archived: currentResponse.ok,
    currentUpdated: true,
    aiPredictionSaved: true,
    updatedAt
  };
}

function firestoreString(value) {
  return {
    stringValue: String(value ?? "")
  };
}

function firestoreInteger(value) {
  return {
    integerValue: String(Math.trunc(Number(value) || 0))
  };
}

function firestoreArray(values) {
  return {
    arrayValue: {
      values: values || []
    }
  };
}

function firestoreMap(fields) {
  return {
    mapValue: {
      fields
    }
  };
}

function analyzeMatch(input) {
  const homeTeam = cleanTeam(input.homeTeam);
  const awayTeam = cleanTeam(input.awayTeam);

  if (!homeTeam || !awayTeam) {
    throw new Error("homeTeam and awayTeam are required");
  }

  const homeForm = parseForm(input.homeForm);
  const awayForm = parseForm(input.awayForm);

  const homeGoals = positiveNumber(input.homeGoals);
  const awayGoals = positiveNumber(input.awayGoals);
  const homeConceded = positiveNumber(input.homeConceded);
  const awayConceded = positiveNumber(input.awayConceded);

  const homeFormScore = calculateFormScore(homeForm);
  const awayFormScore = calculateFormScore(awayForm);

  const homeAttack = calculateAttackScore(homeGoals, awayConceded);
  const awayAttack = calculateAttackScore(awayGoals, homeConceded);

  const homeDefense = calculateDefenseScore(homeConceded);
  const awayDefense = calculateDefenseScore(awayConceded);

  const expectedGoals = calculateExpectedGoals(
    homeGoals,
    awayGoals,
    homeConceded,
    awayConceded
  );

  // Score exact calculé séparément du pronostic principal
  const exactScore = calculateExactScore(
    homeGoals,
    awayGoals,
    homeConceded,
    awayConceded
  );

  const bttsScore = calculateBttsScore(
    homeGoals,
    awayGoals,
    homeConceded,
    awayConceded
  );

  const homeWinScore = calculateHomeWinScore(
    homeFormScore,
    awayFormScore,
    homeAttack,
    awayAttack,
    homeDefense,
    awayDefense
  );

  const over25Score = calculateOver25Score(expectedGoals);
  const under35Score = calculateUnder35Score(expectedGoals);

  const candidates = [
    { prediction: "BTTS", market: "Both Teams To Score", score: bttsScore },
    { prediction: "OVER 2.5", market: "Total Goals", score: over25Score },
    { prediction: "UNDER 3.5", market: "Total Goals", score: under35Score },
    { prediction: "1X", market: "Double Chance", score: homeWinScore },
    { prediction: "X2", market: "Double Chance", score: 100 - homeWinScore }
  ];

  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];
  const confidence = calculateConfidence(
    best.score,
    homeFormScore,
    awayFormScore,
    homeGoals,
    awayGoals,
    homeConceded,
    awayConceded
  );

  const risk =
    confidence >= 80 ? "LOW" :
    confidence >= 65 ? "MEDIUM" :
    "HIGH";

  return {
    match: `${homeTeam} vs ${awayTeam}`,
    homeTeam,
    awayTeam,
    prediction: best.prediction,
    market: best.market,
    confidence,
    risk,
    metrics: {
      homeFormScore,
      awayFormScore,
      homeAttack,
      awayAttack,
      homeDefense,
      awayDefense,
      expectedGoals: round(expectedGoals),
      bttsScore,
      over25Score,
      under35Score,
      homeWinScore,
      exactScore: exactScore.score,
      exactScoreProbability: exactScore.probability,
      homeExpectedGoals: exactScore.homeExpectedGoals,
      awayExpectedGoals: exactScore.awayExpectedGoals
    },
    recommendation:
      `${homeTeam} vs ${awayTeam} → ${best.prediction} (${confidence}% confidence)`
  };
}

function cleanTeam(value) {
  return String(value ?? "").trim().slice(0, 100);
}

function parseForm(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^WDL]/g, "")
    .slice(0, 10)
    .split("");
}

function calculateFormScore(form) {
  if (!form.length) return 50;

  const points = form.reduce((sum, result) => {
    if (result === "W") return sum + 100;
    if (result === "D") return sum + 50;
    return sum;
  }, 0);

  return Math.round(points / form.length);
}

function calculateAttackScore(goals, opponentConceded) {
  return clamp(Math.round((goals * 20) + (opponentConceded * 10)), 0, 100);
}

function calculateDefenseScore(conceded) {
  return clamp(Math.round(100 - (conceded * 10)), 0, 100);
}

function calculateExpectedGoals(
  homeGoals,
  awayGoals,
  homeConceded,
  awayConceded
) {
  const homeExpected = (homeGoals + awayConceded) / 2;
  const awayExpected = (awayGoals + homeConceded) / 2;
  return homeExpected + awayExpected;
}


function poissonProbability(lambda, goals) {
  if (!Number.isFinite(lambda) || lambda <= 0) return 0;

  let factorial = 1;
  for (let i = 2; i <= goals; i++) {
    factorial *= i;
  }

  return Math.exp(-lambda) * Math.pow(lambda, goals) / factorial;
}

function calculateExactScore(
  homeGoals,
  awayGoals,
  homeConceded,
  awayConceded
) {
  const homeExpected = clamp(
    (homeGoals + awayConceded) / 2,
    0.2,
    4.5
  );

  const awayExpected = clamp(
    (awayGoals + homeConceded) / 2,
    0.2,
    4.5
  );

  let bestScore = "1-1";
  let bestProbability = 0;

  for (let home = 0; home <= 5; home++) {
    for (let away = 0; away <= 5; away++) {

      const probability =
        poissonProbability(homeExpected, home) *
        poissonProbability(awayExpected, away);

      if (probability > bestProbability) {
        bestProbability = probability;
        bestScore = `${home}-${away}`;
      }
    }
  }

  return {
    score: bestScore,
    probability: Math.round(bestProbability * 100),
    homeExpectedGoals: round(homeExpected),
    awayExpectedGoals: round(awayExpected)
  };
}

function calculateBttsScore(
  homeGoals,
  awayGoals,
  homeConceded,
  awayConceded
) {
  let score = 0;

  if (homeGoals >= 1) score += 20;
  if (awayGoals >= 1) score += 20;
  if (homeConceded >= 1) score += 20;
  if (awayConceded >= 1) score += 20;

  if (homeGoals >= 1 && awayGoals >= 1) score += 20;

  return clamp(score, 0, 100);
}

function calculateOver25Score(expectedGoals) {
  return clamp(
    Math.round(((expectedGoals - 1.5) / 2) * 100),
    0,
    100
  );
}

function calculateUnder35Score(expectedGoals) {
  return clamp(
    Math.round(((4.5 - expectedGoals) / 2.5) * 100),
    0,
    100
  );
}

function calculateHomeWinScore(
  homeForm,
  awayForm,
  homeAttack,
  awayAttack,
  homeDefense,
  awayDefense
) {
  const score =
    (homeForm * 0.30) +
    ((100 - awayForm) * 0.20) +
    (homeAttack * 0.20) +
    ((100 - awayAttack) * 0.10) +
    (homeDefense * 0.15) +
    ((100 - awayDefense) * 0.05);

  return clamp(Math.round(score), 0, 100);
}

function calculateConfidence(
  strongestScore,
  homeForm,
  awayForm,
  homeGoals,
  awayGoals,
  homeConceded,
  awayConceded
) {
  const formQuality = (homeForm + awayForm) / 2;

  const dataPoints = [
    homeForm.length > 0,
    awayForm.length > 0,
    homeGoals > 0,
    awayGoals > 0,
    homeConceded > 0,
    awayConceded > 0
  ].filter(Boolean).length;

  const dataQuality = (dataPoints / 6) * 100;

  const raw =
    (strongestScore * 0.60) +
    (formQuality * 0.20) +
    (dataQuality * 0.20);

  return clamp(Math.round(raw), 0, 95);
}

function normalizePredictions(body) {
  const source = body.predictions || body;

  const aiMatch1 = String(source.aiMatch1 ?? "").trim();
  const aiMatch2 = String(source.aiMatch2 ?? "").trim();
  const aiMatch3 = String(source.aiMatch3 ?? "").trim();
  const coupon1 = String(source.coupon1 ?? "").trim();
  const coupon2 = String(source.coupon2 ?? "").trim();

  if (!aiMatch1 || !aiMatch2 || !aiMatch3) {
    throw new Error(
      "aiMatch1, aiMatch2 and aiMatch3 are required"
    );
  }

  return {
    aiMatch1: aiMatch1.slice(0, 500),
    aiMatch2: aiMatch2.slice(0, 500),
    aiMatch3: aiMatch3.slice(0, 500),
    coupon1: coupon1.slice(0, 500),
    coupon2: coupon2.slice(0, 500),
    updatedAt: Date.now()
  };
}

async function updateFirestore(env, predictions) {
  if (!env.FIREBASE_PROJECT_ID) {
    throw new Error("FIREBASE_PROJECT_ID is not configured");
  }

  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not configured");
  }

  const serviceAccount =
    JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);

  const token =
    await createAccessToken(serviceAccount);

  const firestoreData = {
    fields: {
      aiMatch1: { stringValue: predictions.aiMatch1 },
      aiMatch2: { stringValue: predictions.aiMatch2 },
      aiMatch3: { stringValue: predictions.aiMatch3 },
      coupon1: { stringValue: predictions.coupon1 },
      coupon2: { stringValue: predictions.coupon2 },
      updatedAt: {
        integerValue: String(predictions.updatedAt)
      }
    }
  };

  const endpoint =
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}` +
    `/databases/(default)/documents/predictions/current`;

  const response = await fetch(endpoint, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(firestoreData)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Firestore error ${response.status}: ${text}`
    );
  }

  return JSON.parse(text);
}

async function createAccessToken(serviceAccount) {
  const header = {
    alg: "RS256",
    typ: "JWT"
  };

  const now = Math.floor(Date.now() / 1000);

  const payload = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };

  const unsignedJWT =
    base64UrlEncode(JSON.stringify(header)) +
    "." +
    base64UrlEncode(JSON.stringify(payload));

  const privateKey =
    await crypto.subtle.importKey(
      "pkcs8",
      pemToArrayBuffer(serviceAccount.private_key),
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256"
      },
      false,
      ["sign"]
    );

  const signature =
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privateKey,
      new TextEncoder().encode(unsignedJWT)
    );

  const jwt =
    unsignedJWT +
    "." +
    arrayBufferToBase64Url(signature);

  const tokenResponse =
    await fetch(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body:
          "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer" +
          `&assertion=${encodeURIComponent(jwt)}`
      }
    );

  const tokenData =
    await tokenResponse.json();

  if (!tokenResponse.ok || !tokenData.access_token) {
    throw new Error(
      `OAuth error ${tokenResponse.status}: ` +
      JSON.stringify(tokenData)
    );
  }

  return tokenData.access_token;
}

function base64UrlEncode(text) {
  return btoa(text)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function arrayBufferToBase64Url(buffer) {
  let binary = "";

  const bytes = new Uint8Array(buffer);

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function pemToArrayBuffer(pem) {
  const cleanKey = String(pem)
    .replace(
      "-----BEGIN PRIVATE KEY-----",
      ""
    )
    .replace(
      "-----END PRIVATE KEY-----",
      ""
    )
    .replace(/\s/g, "");

  const binary = atob(cleanKey);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

function positiveNumber(value) {
  const n = Number(value);

  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }

  return n;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
