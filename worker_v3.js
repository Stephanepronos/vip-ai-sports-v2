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

        /*
         * =====================================================
         * 📅 DATES
         * =====================================================
         */

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

        /*
         * =====================================================
         * ⚽ 1. FOOTBALL-DATA.ORG
         * =====================================================
         */

        if (!env.FOOTBALL_DATA_TOKEN) {
          errors.push({
            source: "football-data.org",
            error: "FOOTBALL_DATA_TOKEN is not configured"
          });
        } else {
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

              console.log(
                "===== FOOTBALL-DATA FIXTURES TRACE =====",
                JSON.stringify({
                  competition: code,
                  competitionName: name,
                  status: response.status,
                  ok: response.ok,
                  response: text.slice(0, 500)
                })
              );

              if (!response.ok) {
                errors.push({
                  source: "football-data.org",
                  competition: code,
                  name,
                  status: response.status,
                  error: text.slice(0, 500)
                });
                continue;
              }

              let data;

              try {
                data = JSON.parse(text);
              } catch {
                errors.push({
                  source: "football-data.org",
                  competition: code,
                  name,
                  error: "Invalid JSON response"
                });
                continue;
              }

              for (const match of data.matches || []) {
                results.push({
                  competition: code,
                  competitionName: name,
                  matchId: match.id,
                  date: match.utcDate,
                  status: match.status,
                  matchday: match.matchday || null,

                  homeTeam:
                    match.homeTeam?.shortName ||
                    match.homeTeam?.name ||
                    "",

                  awayTeam:
                    match.awayTeam?.shortName ||
                    match.awayTeam?.name ||
                    "",

                  homeTeamId: match.homeTeam?.id || null,
                  awayTeamId: match.awayTeam?.id || null,

                  homeCrest: match.homeTeam?.crest || "",
                  awayCrest: match.awayTeam?.crest || "",

                  source: "football-data.org"
                });
              }
            } catch (error) {
              errors.push({
                source: "football-data.org",
                competition: code,
                name,
                error:
                  error instanceof Error
                    ? error.message
                    : "Unknown football-data error"
              });
            }
          }
        }

        /*
         * =====================================================
         * 🇩🇰 2. SOCCERSAPI — SUPERLIGAEN
         * =====================================================
         *
         * SoccerSAPI ne retourne pas correctement toutes les
         * fixtures avec t=season sans team_id.
         *
         * Nous utilisons donc les 12 équipes connues de la
         * saison 21004 et récupérons leurs fixtures une par une.
         *
         * Les matchs sont ensuite filtrés par date et dédupliqués.
         */

        const SOCCERSAPI_FIXTURE_COMPETITIONS = {
          "1609": {
            name: "Superligaen",
            seasonId: "21004",

            teamIds: [
              79,   // FC Copenhagen
              661,  // Viborg FF
              715,  // Silkeborg IF
              716,  // AC Horsens
              717,  // Randers FC
              718,  // Soenderjyske
              720,  // AGF Aarhus
              721,  // Lyngby BK
              722,  // Odense Boldklub
              724,  // Broendby IF
              725,  // FC Midtjylland
              726   // FC Nordsjaelland
            ]
          }
        };

        if (!env.SOCCER_API_USER || !env.SOCCER_API_KEY) {

          errors.push({
            source: "soccersapi",
            competition: "1609",
            name: "Superligaen",
            error: "SOCCER_API_USER or SOCCER_API_KEY missing"
          });

        } else {

          for (
            const [leagueId, leagueConfig]
              of Object.entries(SOCCERSAPI_FIXTURE_COMPETITIONS)
          ) {

            const superligaMatches = new Map();

            for (const teamId of leagueConfig.teamIds) {

              try {

                const fixturesUrl =
                  `https://api.soccersapi.com/v2.2/fixtures/` +
                  `?user=${encodeURIComponent(env.SOCCER_API_USER)}` +
                  `&token=${encodeURIComponent(env.SOCCER_API_KEY)}` +
                  `&t=season` +
                  `&season_id=${encodeURIComponent(leagueConfig.seasonId)}` +
                  `&team_id=${encodeURIComponent(teamId)}`;

                const response = await fetch(fixturesUrl, {
                  method: "GET",
                  headers: {
                    "Accept": "application/json"
                  }
                });

                const text = await response.text();

                console.log(
                  "===== SOCCERSAPI SUPERLIGA TEAM TRACE =====",
                  JSON.stringify({
                    competition: leagueId,
                    competitionName: leagueConfig.name,
                    seasonId: leagueConfig.seasonId,
                    teamId,
                    status: response.status,
                    ok: response.ok,
                    response: text.slice(0, 300)
                  })
                );

                if (!response.ok) {

                  errors.push({
                    source: "soccersapi",
                    competition: leagueId,
                    name: leagueConfig.name,
                    seasonId: leagueConfig.seasonId,
                    teamId,
                    status: response.status,
                    error: text.slice(0, 500)
                  });

                  continue;
                }

                let data;

                try {
                  data = JSON.parse(text);
                } catch {

                  errors.push({
                    source: "soccersapi",
                    competition: leagueId,
                    name: leagueConfig.name,
                    seasonId: leagueConfig.seasonId,
                    teamId,
                    error: "Invalid SoccerSAPI JSON"
                  });

                  continue;
                }

                const fixtures =
                  Array.isArray(data.data)
                    ? data.data
                    : [];

                console.log(
                  "===== SOCCERSAPI SUPERLIGA TEAM COUNT =====",
                  JSON.stringify({
                    teamId,
                    count: fixtures.length
                  })
                );

                for (const fixture of fixtures) {

                  const fixtureDate =
                    fixture?.time?.date || "";

                  if (!fixtureDate) {
                    continue;
                  }

                  const fixtureDateOnly =
                    String(fixtureDate).slice(0, 10);

                  /*
                   * Garder uniquement la période demandée.
                   */
                  if (
                    fixtureDateOnly < dateFrom ||
                    fixtureDateOnly > dateTo
                  ) {
                    continue;
                  }

                  const statusName =
                    String(
                      fixture?.status_name || ""
                    ).toLowerCase();

                  /*
                   * Garder uniquement les matchs à venir.
                   */
                  if (
                    statusName === "finished" ||
                    statusName === "cancelled" ||
                    statusName === "canceled" ||
                    statusName === "postponed"
                  ) {
                    continue;
                  }

                  const home =
                    fixture?.teams?.home || {};

                  const away =
                    fixture?.teams?.away || {};

                  if (!home.id || !away.id) {
                    continue;
                  }

                  /*
                   * Identifiant stable pour éviter qu'un même
                   * match soit ajouté deux fois lorsqu'il apparaît
                   * dans les fixtures des deux équipes.
                   */
                  const fixtureKey =
                    String(
                      fixture.id ||
                      `${fixtureDateOnly}_${home.id}_${away.id}`
                    );

                  if (superligaMatches.has(fixtureKey)) {
                    continue;
                  }

                  const result = {
                    competition: leagueId,

                    competitionName:
                      leagueConfig.name,

                    matchId:
                      fixture.id || null,

                    date:
                      fixture?.time?.datetime ||
                      `${fixtureDateOnly}T00:00:00Z`,

                    status:
                      fixture?.status_name ||
                      "Notstarted",

                    matchday:
                      fixture?.week ||
                      fixture?.round_name ||
                      null,

                    homeTeam:
                      home.name ||
                      "",

                    awayTeam:
                      away.name ||
                      "",

                    homeTeamId:
                      Number(home.id) ||
                      null,

                    awayTeamId:
                      Number(away.id) ||
                      null,

                    homeCrest:
                      home.img ||
                      "",

                    awayCrest:
                      away.img ||
                      "",

                    source: "soccersapi"
                  };

                  superligaMatches.set(
                    fixtureKey,
                    result
                  );

                  console.log(
                    "===== SOCCERSAPI SUPERLIGA MATCH ADDED =====",
                    JSON.stringify({
                      matchId: result.matchId,
                      date: result.date,
                      homeTeam: result.homeTeam,
                      awayTeam: result.awayTeam,
                      competition: result.competition,
                      competitionName:
                        result.competitionName,
                      source: result.source
                    })
                  );
                }

              } catch (error) {

                errors.push({
                  source: "soccersapi",
                  competition: leagueId,
                  name: leagueConfig.name,
                  seasonId: leagueConfig.seasonId,
                  teamId,

                  error:
                    error instanceof Error
                      ? error.message
                      : "Unknown SoccerSAPI team fixtures error"
                });
              }
            }

            /*
             * Ajouter les matchs Superliga dédupliqués aux résultats
             * principaux.
             */
            for (const match of superligaMatches.values()) {
              results.push(match);
            }

            console.log(
              "===== SOCCERSAPI SUPERLIGA FIXTURES COUNT =====",
              JSON.stringify({
                competition: leagueId,
                seasonId: leagueConfig.seasonId,
                teamsChecked: leagueConfig.teamIds.length,
                uniqueMatches:
                  superligaMatches.size
              })
            );
          }
        }

        /*
         * =====================================================
         * 📅 TRI FINAL
         * =====================================================
         */

        results.sort(
          (a, b) =>
            new Date(a.date).getTime() -
            new Date(b.date).getTime()
        );

        const sourceCounts = {};

        for (const match of results) {
          const source =
            match.source || "unknown";

          sourceCounts[source] =
            (sourceCounts[source] || 0) + 1;
        }

        console.log(
          "===== HYBRID FIXTURES RESULT =====",
          JSON.stringify({
            dateFrom,
            dateTo,
            count: results.length,
            sourceCounts,
            superligaMatches:
              results.filter(
                m => String(m.competition) === "1609"
              ).length
          })
        );

        return corsResponse({
          status: "SUCCESS",
          source: "hybrid",
          dateFrom,
          dateTo,

          competitions: {
            ...competitions,
            "1609": "Superligaen"
          },

          count: results.length,
          matches: results,
          errors
        }, 200, origin);
      }

      // =========================================================
      // =========================================================
      // 📊 REAL TEAM STATS — SPORTMONKS
      // =========================================================

      /*
       * IMPORTANT :
       * Les IDs de Football-Data.org et SportMonks sont différents.
       * Nous utilisons donc le NOM de l'équipe pour retrouver
       * son ID SportMonks.
       *
       * Flux :
       * Football-Data match
       *       ↓
       * team name
       *       ↓
       * SportMonks team search
       *       ↓
       * SportMonks team ID
       *       ↓
       * derniers matchs + scores
       */

      /*
       * =========================================================
       * 📊 REAL TEAM STATS — FOOTBALL-DATA.ORG
       * =========================================================
       *
       * Utilise directement l'ID Football-data.org présent
       * dans le match (/fixtures).
       *
       * Retour :
       * - 5 derniers matchs terminés
       * - forme W/D/L
       * - buts marqués
       * - buts encaissés
       *
       * Cette fonction sert de fallback lorsque SoccerSAPI
       * ne fournit pas les statistiques.
       */

      async function getFootballDataTeamStats(
        teamName,
        teamId,
        env,
        cache
      ) {
        console.log(
          "===== GET FOOTBALL-DATA TEAM STATS CALLED =====",
          JSON.stringify({
            teamName,
            teamId
          })
        );

        if (!teamName || !teamId) {
          return {
            form: "",
            goals: 0,
            conceded: 0,
            matches: 0,
            hasData: false,
            source: "football-data.org",
            error: "Missing Football-data team ID"
          };
        }

        if (!env.FOOTBALL_DATA_TOKEN) {
          return {
            form: "",
            goals: 0,
            conceded: 0,
            matches: 0,
            hasData: false,
            source: "football-data.org",
            error: "FOOTBALL_DATA_TOKEN is not configured"
          };
        }

        const statsCacheKey =
          `football-data-stats:${String(teamId)}`;

        if (cache && cache.has(statsCacheKey)) {
          return cache.get(statsCacheKey);
        }

        const today = new Date();
        const fromDate = new Date(today);

        /*
         * 365 jours permettent de récupérer suffisamment
         * de matchs même en début de saison.
         */
        fromDate.setDate(fromDate.getDate() - 365);

        const dateFrom =
          fromDate.toISOString().slice(0, 10);

        const dateTo =
          today.toISOString().slice(0, 10);

        try {
          const apiUrl =
            `https://api.football-data.org/v4/teams/` +
            `${encodeURIComponent(teamId)}/matches` +
            `?status=FINISHED` +
            `&dateFrom=${dateFrom}` +
            `&dateTo=${dateTo}` +
            `&limit=20`;

          const response = await fetch(apiUrl, {
            method: "GET",
            headers: {
              "X-Auth-Token": env.FOOTBALL_DATA_TOKEN,
              "Accept": "application/json"
            }
          });

          const text = await response.text();

          console.log(
            "===== FOOTBALL-DATA TEAM STATS TRACE =====",
            JSON.stringify({
              teamName,
              teamId,
              dateFrom,
              dateTo,
              status: response.status,
              ok: response.ok,
              response: text.slice(0, 700)
            })
          );

          if (!response.ok) {
            const result = {
              form: "",
              goals: 0,
              conceded: 0,
              matches: 0,
              hasData: false,
              source: "football-data.org",
              error: `Football-data team matches ${response.status}`
            };

            if (cache) {
              cache.set(statsCacheKey, result);
            }

            return result;
          }

          let data;

          try {
            data = JSON.parse(text);
          } catch {
            const result = {
              form: "",
              goals: 0,
              conceded: 0,
              matches: 0,
              hasData: false,
              source: "football-data.org",
              error: "Invalid Football-data team matches JSON"
            };

            if (cache) {
              cache.set(statsCacheKey, result);
            }

            return result;
          }

          const matches = Array.isArray(data.matches)
            ? data.matches
            : [];

          const finishedMatches = matches
            .filter(match => {
              const score = match.score || {};

              const fullTime = score.fullTime || {};

              return (
                match.status === "FINISHED" &&
                Number.isFinite(Number(fullTime.home)) &&
                Number.isFinite(Number(fullTime.away))
              );
            })
            .sort(
              (a, b) =>
                new Date(b.utcDate).getTime() -
                new Date(a.utcDate).getTime()
            );

          const recent = [];

          for (const match of finishedMatches) {
            if (recent.length >= 5) break;

            const homeId =
              Number(match.homeTeam?.id);

            const awayId =
              Number(match.awayTeam?.id);

            const ownId =
              Number(teamId);

            const homeGoals =
              Number(match.score?.fullTime?.home);

            const awayGoals =
              Number(match.score?.fullTime?.away);

            if (
              !Number.isFinite(homeId) ||
              !Number.isFinite(awayId) ||
              !Number.isFinite(homeGoals) ||
              !Number.isFinite(awayGoals)
            ) {
              continue;
            }

            const isHome =
              homeId === ownId;

            const isAway =
              awayId === ownId;

            if (!isHome && !isAway) {
              continue;
            }

            const teamGoals =
              isHome ? homeGoals : awayGoals;

            const teamConceded =
              isHome ? awayGoals : homeGoals;

            let resultLetter = "D";

            if (teamGoals > teamConceded) {
              resultLetter = "W";
            } else if (teamGoals < teamConceded) {
              resultLetter = "L";
            }

            const opponent =
              isHome
                ? (
                    match.awayTeam?.shortName ||
                    match.awayTeam?.name ||
                    ""
                  )
                : (
                    match.homeTeam?.shortName ||
                    match.homeTeam?.name ||
                    ""
                  );

            recent.push({
              fixtureId: match.id,
              date: match.utcDate,
              opponent,
              goals: teamGoals,
              conceded: teamConceded,
              result: resultLetter
            });
          }

          if (!recent.length) {
            const result = {
              form: "",
              goals: 0,
              conceded: 0,
              matches: 0,
              hasData: false,
              source: "football-data.org",
              error: "No valid finished Football-data matches found",
              footballDataTeamId: Number(teamId),
              teamName
            };

            if (cache) {
              cache.set(statsCacheKey, result);
            }

            return result;
          }

          let goals = 0;
          let conceded = 0;
          let form = "";

          for (const recentMatch of recent) {
            goals += Number(recentMatch.goals);
            conceded += Number(recentMatch.conceded);
            form += recentMatch.result;
          }

          const validMatches = recent.length;

          const result = {
            form,
            goals: Number(
              (goals / validMatches).toFixed(2)
            ),
            conceded: Number(
              (conceded / validMatches).toFixed(2)
            ),
            matches: validMatches,
            hasData: validMatches > 0,
            source: "football-data.org",
            footballDataTeamId: Number(teamId),
            teamName,
            recentMatches: recent
          };

          console.log(
            "===== FOOTBALL-DATA TEAM STATS RESULT =====",
            JSON.stringify({
              teamName,
              teamId,
              form: result.form,
              goals: result.goals,
              conceded: result.conceded,
              matches: result.matches
            })
          );

          if (cache) {
            cache.set(statsCacheKey, result);
          }

          return result;

        } catch (error) {
          const result = {
            form: "",
            goals: 0,
            conceded: 0,
            matches: 0,
            hasData: false,
            source: "football-data.org",
            error:
              error instanceof Error
                ? error.message
                : "Unknown Football-data statistics error"
          };

          if (cache) {
            cache.set(statsCacheKey, result);
          }

          return result;
        }
      }

      async function searchSportMonksTeam(teamName, env, cache) {
        const name = String(teamName ?? "").trim();

        if (!name) {
          return {
            id: null,
            name: "",
            hasData: false,
            error: "Missing team name"
          };
        }

        if (!env.SPORTMONKS_API_TOKEN) {
          return {
            id: null,
            name,
            hasData: false,
            error: "SPORTMONKS_API_TOKEN missing"
          };
        }

        const normalizedName = name
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, " ")
          .trim();

        const cacheKey = `sportmonks-team:${normalizedName}`;

        if (cache && cache.has(cacheKey)) {
          return cache.get(cacheKey);
        }

        /*
         * =====================================================
         * SPORTMONKS KNOWN TEAM IDS
         * =====================================================
         *
         * Le endpoint /teams/search peut retourner []
         * avec le Free Plan pour certaines grandes équipes.
         *
         * On utilise donc les IDs connus directement.
         */

        const knownTeams = {
          "real madrid": {
            id: 3468,
            name: "Real Madrid"
          },

          "real madrid cf": {
            id: 3468,
            name: "Real Madrid"
          },

          "barcelona": {
            id: 83,
            name: "Barcelona"
          },

          "fc barcelona": {
            id: 83,
            name: "Barcelona"
          },

          "paris saint germain": {
            id: 591,
            name: "Paris Saint-Germain"
          },

          "paris saint germain fc": {
            id: 591,
            name: "Paris Saint-Germain"
          },

          "psg": {
            id: 591,
            name: "Paris Saint-Germain"
          },

          "arsenal": {
            id: 19,
            name: "Arsenal"
          },

          "arsenal fc": {
            id: 19,
            name: "Arsenal"
          },

          "bayern munich": {
            id: 503,
            name: "Bayern Munich"
          },

          "bayern munchen": {
            id: 503,
            name: "Bayern Munich"
          },

          "fc bayern munich": {
            id: 503,
            name: "Bayern Munich"
          }
        };

        /*
         * =====================================================
         * 1️⃣ ID SPORTMONKS CONNU
         * =====================================================
         */

        const known = knownTeams[normalizedName];

        if (known) {
          const result = {
            id: known.id,
            name: known.name,
            shortCode: "",
            imagePath: "",
            hasData: true,
            source: "known_sportmonks_id"
          };

          console.log(
            "===== SPORTMONKS KNOWN TEAM ID =====",
            JSON.stringify({
              requestedName: name,
              normalizedName,
              sportmonksTeamId: result.id,
              resolvedName: result.name
            })
          );

          if (cache) {
            cache.set(cacheKey, result);
          }

          return result;
        }

        /*
         * =====================================================
         * 2️⃣ FALLBACK : RECHERCHE SPORTMONKS
         * =====================================================
         */

        try {
          const apiUrl =
            `https://api.sportmonks.com/v3/football/teams/search/` +
            `${encodeURIComponent(name)}` +
            `?api_token=${encodeURIComponent(env.SPORTMONKS_API_TOKEN)}`;

          const response = await fetch(apiUrl, {
            method: "GET",
            headers: {
              "Accept": "application/json"
            }
          });

          const text = await response.text();

          console.log(
            "===== SPORTMONKS TEAM SEARCH TRACE =====",
            JSON.stringify({
              requestedName: name,
              normalizedName,
              status: response.status,
              ok: response.ok,
              response: text.slice(0, 500)
            })
          );

          if (!response.ok) {
            const result = {
              id: null,
              name,
              hasData: false,
              error: `SportMonks team search ${response.status}`
            };

            if (cache) cache.set(cacheKey, result);

            return result;
          }

          let data;

          try {
            data = JSON.parse(text);
          } catch {
            const result = {
              id: null,
              name,
              hasData: false,
              error: "Invalid SportMonks JSON"
            };

            if (cache) cache.set(cacheKey, result);

            return result;
          }

          const teams = Array.isArray(data.data)
            ? data.data
            : [];

          if (!teams.length) {
            const result = {
              id: null,
              name,
              hasData: false,
              error: "SportMonks team not found"
            };

            if (cache) cache.set(cacheKey, result);

            return result;
          }

          /*
           * SportMonks peut retourner plusieurs résultats.
           * On privilégie le nom exact, sinon le premier.
           */

          const exact =
            teams.find(team => {
              const teamNormalized = String(team.name ?? "")
                .trim()
                .toLowerCase()
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .replace(/[^a-z0-9]+/g, " ")
                .trim();

              return teamNormalized === normalizedName;
            }) || teams[0];

          const result = {
            id: Number(exact.id) || null,
            name: exact.name || name,
            shortCode: exact.short_code || "",
            imagePath: exact.image_path || "",
            hasData: !!exact.id,
            source: "sportmonks_search"
          };

          if (!result.id) {
            result.hasData = false;
            result.error = "SportMonks team ID missing";
          }

          if (cache) {
            cache.set(cacheKey, result);
          }

          return result;

        } catch (error) {
          const result = {
            id: null,
            name,
            hasData: false,
            error:
              error instanceof Error
                ? error.message
                : "Unknown SportMonks team search error"
          };

          if (cache) {
            cache.set(cacheKey, result);
          }

          return result;
        }
      }

      async function getSportMonksTeamStats(
        teamName,
        env,
        cache
      ) {
        console.log(
          "===== GET SPORTMONKS TEAM STATS CALLED =====",
          JSON.stringify({ teamName })
        );

        if (!teamName) {
          return {
            form: "",
            goals: 0,
            conceded: 0,
            matches: 0,
            hasData: false,
            error: "Missing team name"
          };
        }

        if (!env.SPORTMONKS_API_TOKEN) {
          return {
            form: "",
            goals: 0,
            conceded: 0,
            matches: 0,
            hasData: false,
            error: "SPORTMONKS_API_TOKEN missing"
          };
        }

        const normalizedName =
          String(teamName).trim().toLowerCase();

        const statsCacheKey =
          `sportmonks-stats:${normalizedName}`;

        if (cache && cache.has(statsCacheKey)) {
          return cache.get(statsCacheKey);
        }

        /*
         * 180 jours d'historique.
         * On cherche suffisamment de matchs pour obtenir
         * les 5 derniers matchs terminés.
         */
        const today = new Date();

        const fromDate = new Date(today);
        fromDate.setDate(fromDate.getDate() - 180);

        const dateFrom =
          fromDate.toISOString().slice(0, 10);

        const dateTo =
          today.toISOString().slice(0, 10);

        /*
         * SportMonks Team ID
         */
        const team = await searchSportMonksTeam(
          teamName,
          env,
          cache
        );

        if (!team.id) {
          const result = {
            form: "",
            goals: 0,
            conceded: 0,
            matches: 0,
            hasData: false,
            error: team.error || "SportMonks team ID not found",
            sportmonksTeamId: null
          };

          if (cache) {
            cache.set(statsCacheKey, result);
          }

          return result;
        }

        try {
          const apiUrl =
            `https://api.sportmonks.com/v3/football/fixtures/between/` +
            `${dateFrom}/${dateTo}/${team.id}` +
            `?include=participants;scores` +
            `&api_token=${encodeURIComponent(env.SPORTMONKS_API_TOKEN)}`;

          const response = await fetch(apiUrl, {
            method: "GET",
            headers: {
              "Accept": "application/json"
            }
          });

          const text = await response.text();

          console.log(
            "===== SPORTMONKS FIXTURES TRACE =====",
            JSON.stringify({
              teamName,
              sportmonksTeamId: team.id,
              dateFrom,
              dateTo,
              status: response.status,
              ok: response.ok,
              response: text.slice(0, 700)
            })
          );

          if (!response.ok) {
            const result = {
              form: "",
              goals: 0,
              conceded: 0,
              matches: 0,
              hasData: false,
              error: `SportMonks fixtures ${response.status}`,
              sportmonksTeamId: team.id
            };

            if (cache) {
              cache.set(statsCacheKey, result);
            }

            return result;
          }

          let data;

          try {
            data = JSON.parse(text);
          } catch {
            const result = {
              form: "",
              goals: 0,
              conceded: 0,
              matches: 0,
              hasData: false,
              error: "Invalid SportMonks fixtures JSON",
              sportmonksTeamId: team.id
            };

            if (cache) {
              cache.set(statsCacheKey, result);
            }

            return result;
          }

          const fixtures = Array.isArray(data.data)
            ? data.data
            : [];

          /*
           * On garde uniquement les matchs réellement terminés
           * et ayant des participants + scores.
           */
          const finishedFixtures = fixtures
            .filter(fixture => {
              const startingAt =
                new Date(fixture.starting_at);

              const hasValidDate =
                Number.isFinite(startingAt.getTime()) &&
                startingAt.getTime() < Date.now();

              const participants =
                Array.isArray(fixture.participants)
                  ? fixture.participants
                  : [];

              const scores =
                Array.isArray(fixture.scores)
                  ? fixture.scores
                  : [];

              return (
                hasValidDate &&
                participants.length >= 2 &&
                scores.length > 0
              );
            })
            .sort(
              (a, b) =>
                new Date(b.starting_at).getTime() -
                new Date(a.starting_at).getTime()
            );

          const recent = [];

          for (const fixture of finishedFixtures) {
            if (recent.length >= 5) break;

            const participants =
              Array.isArray(fixture.participants)
                ? fixture.participants
                : [];

            const scores =
              Array.isArray(fixture.scores)
                ? fixture.scores
                : [];

            const currentScores =
              scores.filter(score =>
                String(score.description ?? "")
                  .toUpperCase() === "CURRENT"
              );

            /*
             * Si CURRENT n'existe pas, on prend le score
             * de type 1525.
             */
            const finalScores =
              currentScores.length
                ? currentScores
                : scores.filter(score =>
                    Number(score.type_id) === 1525
                  );

            if (!finalScores.length) {
              continue;
            }

            const ownParticipant =
              participants.find(p =>
                Number(p.id) === Number(team.id)
              );

            if (!ownParticipant) {
              continue;
            }

            const opponentParticipant =
              participants.find(p =>
                Number(p.id) !== Number(team.id)
              );

            if (!opponentParticipant) {
              continue;
            }

            const ownScore =
              finalScores.find(score =>
                Number(score.participant_id) ===
                Number(team.id)
              );

            const opponentScore =
              finalScores.find(score =>
                Number(score.participant_id) ===
                Number(opponentParticipant.id)
              );

            if (!ownScore || !opponentScore) {
              continue;
            }

            const teamGoals =
              Number(ownScore.score?.goals);

            const teamConceded =
              Number(opponentScore.score?.goals);

            if (
              !Number.isFinite(teamGoals) ||
              !Number.isFinite(teamConceded)
            ) {
              continue;
            }

            let resultLetter = "D";

            if (teamGoals > teamConceded) {
              resultLetter = "W";
            } else if (teamGoals < teamConceded) {
              resultLetter = "L";
            }

            recent.push({
              fixtureId: fixture.id,
              date: fixture.starting_at,
              opponent:
                opponentParticipant.name || "",
              goals: teamGoals,
              conceded: teamConceded,
              result: resultLetter
            });
          }

          if (!recent.length) {
            const result = {
              form: "",
              goals: 0,
              conceded: 0,
              matches: 0,
              hasData: false,
              error: "No valid finished SportMonks matches found",
              sportmonksTeamId: team.id,
              teamName: team.name
            };

            if (cache) {
              cache.set(statsCacheKey, result);
            }

            return result;
          }

          let goals = 0;
          let conceded = 0;
          let form = "";

          for (const match of recent) {
            goals += Number(match.goals);
            conceded += Number(match.conceded);
            form += match.result;
          }

          const validMatches = recent.length;

          const result = {
            form,
            goals: Number(
              (goals / validMatches).toFixed(2)
            ),
            conceded: Number(
              (conceded / validMatches).toFixed(2)
            ),
            matches: validMatches,
            hasData: validMatches > 0,

            sportmonksTeamId: team.id,
            teamName: team.name,

            recentMatches: recent
          };

          console.log(
            "===== SPORTMONKS TEAM STATS RESULT =====",
            JSON.stringify({
              teamName,
              sportmonksTeamId: team.id,
              form: result.form,
              goals: result.goals,
              conceded: result.conceded,
              matches: result.matches
            })
          );

          if (cache) {
            cache.set(statsCacheKey, result);
          }

          return result;

        } catch (error) {
          const result = {
            form: "",
            goals: 0,
            conceded: 0,
            matches: 0,
            hasData: false,
            error:
              error instanceof Error
                ? error.message
                : "Unknown SportMonks statistics error",
            sportmonksTeamId: team.id
          };

          if (cache) {
            cache.set(statsCacheKey, result);
          }

          return result;
        }
      }



      // =========================================================
      // ⚽ SOCCERSAPI — TEAM STATS
      // =========================================================

      function normalizeSoccerTeamName(value) {
        return String(value ?? "")
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
      }

      const SOCCERSAPI_COMPETITIONS = {
        "974": {
          name: "A-League",
          seasonId: "21306"
        },

        "1005": {
          name: "Tipico Bundesliga",
          seasonId: "21096"
        },

        "1609": {
          name: "Superligaen",
          seasonId: "21004"
        }
      };

      async function searchSoccerSapiTeam(teamName, env, cache) {
        const name = String(teamName ?? "").trim();

        if (!name) {
          return {
            id: null,
            name: "",
            hasData: false,
            error: "Missing team name"
          };
        }

        if (!env.SOCCER_API_USER || !env.SOCCER_API_KEY) {
          return {
            id: null,
            name,
            hasData: false,
            error: "SOCCER_API_USER or SOCCER_API_KEY missing"
          };
        }

        const normalized = normalizeSoccerTeamName(name);
        const cacheKey = `soccersapi-team:${normalized}`;

        if (cache && cache.has(cacheKey)) {
          return cache.get(cacheKey);
        }

        try {
          // =====================================================
          // 1. RECHERCHE NORMALE SOCCERSAPI
          // =====================================================

          const apiUrl =
            `https://api.soccersapi.com/v2.2/search/` +
            `?user=${encodeURIComponent(env.SOCCER_API_USER)}` +
            `&token=${encodeURIComponent(env.SOCCER_API_KEY)}` +
            `&t=team` +
            `&q=${encodeURIComponent(name)}`;

          const response = await fetch(apiUrl, {
            method: "GET",
            headers: {
              "Accept": "application/json"
            }
          });

          const searchText = await response.text();

          console.log(
            "===== SOCCERSAPI TEAM SEARCH TRACE =====",
            JSON.stringify({
              teamName: name,
              status: response.status,
              ok: response.ok,
              response: searchText.slice(0, 700)
            })
          );

          if (response.ok) {
            try {
              const data = JSON.parse(searchText);

              const teams = Array.isArray(data.data)
                ? data.data
                : [];

              if (teams.length) {
                const exact =
                  teams.find(team =>
                    normalizeSoccerTeamName(team.name) === normalized
                  ) || teams[0];

                const result = {
                  id: Number(exact.id) || null,
                  name: exact.name || name,
                  shortCode: exact.short_code || "",
                  image: exact.img || "",
                  hasData: !!exact.id,
                  source: "soccersapi_search"
                };

                if (!result.id) {
                  result.hasData = false;
                  result.error = "SoccerSAPI team ID missing";
                }

                if (cache) cache.set(cacheKey, result);

                return result;
              }

              console.log(
                "===== SOCCERSAPI SEARCH EMPTY =====",
                JSON.stringify({
                  teamName: name,
                  message: "Direct team search returned no team"
                })
              );

            } catch {
              console.log(
                "===== SOCCERSAPI SEARCH JSON INVALID =====",
                JSON.stringify({
                  teamName: name
                })
              );
            }
          }

          // =====================================================
          // 2. FALLBACK FIXTURES / SAISON
          //
          // On utilise les compétitions connues dans
          // SOCCERSAPI_COMPETITIONS.
          //
          // Le but est de retrouver l'ID réel de l'équipe
          // directement dans les fixtures de la saison.
          // =====================================================

          for (const [leagueId, leagueConfig] of Object.entries(
            SOCCERSAPI_COMPETITIONS
          )) {
            if (!leagueConfig?.seasonId) {
              continue;
            }

            try {
              const fixturesUrl =
                `https://api.soccersapi.com/v2.2/fixtures/` +
                `?user=${encodeURIComponent(env.SOCCER_API_USER)}` +
                `&token=${encodeURIComponent(env.SOCCER_API_KEY)}` +
                `&t=season` +
                `&season_id=${encodeURIComponent(leagueConfig.seasonId)}`;

              const fixturesResponse = await fetch(fixturesUrl, {
                method: "GET",
                headers: {
                  "Accept": "application/json"
                }
              });

              const fixturesText = await fixturesResponse.text();

              console.log(
                "===== SOCCERSAPI TEAM FIXTURE FALLBACK =====",
                JSON.stringify({
                  teamName: name,
                  leagueId,
                  seasonId: leagueConfig.seasonId,
                  status: fixturesResponse.status,
                  ok: fixturesResponse.ok,
                  response: fixturesText.slice(0, 500)
                })
              );

              if (!fixturesResponse.ok) {
                continue;
              }

              let fixturesData;

              try {
                fixturesData = JSON.parse(fixturesText);
              } catch {
                continue;
              }

              const fixtures = Array.isArray(fixturesData.data)
                ? fixturesData.data
                : [];

              for (const fixture of fixtures) {
                const home = fixture?.teams?.home || {};
                const away = fixture?.teams?.away || {};

                const candidates = [home, away];

                const found = candidates.find(team => {
                  const teamNormalized =
                    normalizeSoccerTeamName(team?.name);

                  return (
                    teamNormalized === normalized ||
                    teamNormalized.includes(normalized) ||
                    normalized.includes(teamNormalized)
                  );
                });

                if (!found?.id) {
                  continue;
                }

                const result = {
                  id: Number(found.id) || null,
                  name: found.name || name,
                  shortCode: found.short_code || "",
                  image: found.img || "",
                  hasData: !!found.id,
                  source: "soccersapi_fixture_fallback",
                  competitionId: leagueId,
                  seasonId: String(leagueConfig.seasonId)
                };

                console.log(
                  "===== SOCCERSAPI TEAM FOUND IN FIXTURES =====",
                  JSON.stringify({
                    requestedTeam: name,
                    foundTeam: result.name,
                    teamId: result.id,
                    competitionId: leagueId,
                    seasonId: leagueConfig.seasonId,
                    fixtureId: fixture?.id || null
                  })
                );

                if (cache) cache.set(cacheKey, result);

                return result;
              }

            } catch (fallbackError) {
              console.log(
                "===== SOCCERSAPI FIXTURE FALLBACK ERROR =====",
                JSON.stringify({
                  teamName: name,
                  leagueId,
                  error:
                    fallbackError instanceof Error
                      ? fallbackError.message
                      : "Unknown fixture fallback error"
                })
              );
            }
          }

          // =====================================================
          // 3. AUCUN ID TROUVÉ
          // =====================================================

          const result = {
            id: null,
            name,
            hasData: false,
            error: "SoccerSAPI team not found in search or fixtures"
          };

          if (cache) cache.set(cacheKey, result);

          return result;

        } catch (error) {
          const result = {
            id: null,
            name,
            hasData: false,
            error:
              error instanceof Error
                ? error.message
                : "Unknown SoccerSAPI team search error"
          };

          if (cache) cache.set(cacheKey, result);

          return result;
        }
      }

      async function getSoccerSapiTeamStats(
        teamName,
        competition,
        env,
        cache
      ) {
        console.log(
          "===== GET SOCCERSAPI TEAM STATS CALLED =====",
          JSON.stringify({
            teamName,
            competition
          })
        );

        if (!teamName) {
          return {
            form: "",
            goals: 0,
            conceded: 0,
            matches: 0,
            hasData: false,
            error: "Missing team name",
            source: "soccersapi"
          };
        }

        if (!env.SOCCER_API_USER || !env.SOCCER_API_KEY) {
          return {
            form: "",
            goals: 0,
            conceded: 0,
            matches: 0,
            hasData: false,
            error: "SOCCER_API_USER or SOCCER_API_KEY missing",
            source: "soccersapi"
          };
        }

        const leagueId = String(
          competition?.id ??
          competition?.leagueId ??
          competition ??
          ""
        );

        const leagueConfig =
          SOCCERSAPI_COMPETITIONS[leagueId];

        if (!leagueConfig) {
          return {
            form: "",
            goals: 0,
            conceded: 0,
            matches: 0,
            hasData: false,
            error: `SoccerSAPI competition ${leagueId || "unknown"} not available on current plan`,
            source: "soccersapi"
          };
        }

        const normalized = normalizeSoccerTeamName(teamName);

        const cacheKey =
          `soccersapi-stats:${leagueId}:${leagueConfig.seasonId}:${normalized}`;

        if (cache && cache.has(cacheKey)) {
          return cache.get(cacheKey);
        }

        const team = await searchSoccerSapiTeam(
          teamName,
          env,
          cache
        );

        if (!team.id) {
          const result = {
            form: "",
            goals: 0,
            conceded: 0,
            matches: 0,
            hasData: false,
            error: team.error || "SoccerSAPI team ID not found",
            sportSapiTeamId: null,
            source: "soccersapi"
          };

          if (cache) cache.set(cacheKey, result);

          return result;
        }

        try {
          const apiUrl =
            `https://api.soccersapi.com/v2.2/fixtures/` +
            `?user=${encodeURIComponent(env.SOCCER_API_USER)}` +
            `&token=${encodeURIComponent(env.SOCCER_API_KEY)}` +
            `&t=season` +
            `&season_id=${encodeURIComponent(leagueConfig.seasonId)}` +
            `&team_id=${encodeURIComponent(team.id)}`;

          const response = await fetch(apiUrl, {
            method: "GET",
            headers: {
              "Accept": "application/json"
            }
          });

          const text = await response.text();

          console.log(
            "===== SOCCERSAPI FIXTURES TRACE =====",
            JSON.stringify({
              teamName,
              teamId: team.id,
              leagueId,
              seasonId: leagueConfig.seasonId,
              status: response.status,
              ok: response.ok,
              response: text.slice(0, 700)
            })
          );

          if (!response.ok) {
            const result = {
              form: "",
              goals: 0,
              conceded: 0,
              matches: 0,
              hasData: false,
              error: `SoccerSAPI fixtures ${response.status}`,
              sportSapiTeamId: team.id,
              source: "soccersapi"
            };

            if (cache) cache.set(cacheKey, result);

            return result;
          }

          let data;

          try {
            data = JSON.parse(text);
          } catch {
            const result = {
              form: "",
              goals: 0,
              conceded: 0,
              matches: 0,
              hasData: false,
              error: "Invalid SoccerSAPI fixtures JSON",
              sportSapiTeamId: team.id,
              source: "soccersapi"
            };

            if (cache) cache.set(cacheKey, result);

            return result;
          }

          const fixtures = Array.isArray(data.data)
            ? data.data
            : [];

          const finished = fixtures
            .filter(fixture => {
              if (
                String(fixture.status_name ?? "")
                  .toLowerCase() !== "finished"
              ) {
                return false;
              }

              const teams = fixture.teams || {};
              const home = teams.home || {};
              const away = teams.away || {};
              const scores = fixture.scores || {};

              if (!home.id || !away.id) return false;

              if (
                Number(home.id) !== Number(team.id) &&
                Number(away.id) !== Number(team.id)
              ) {
                return false;
              }

              const homeScore = Number(scores.home_score);
              const awayScore = Number(scores.away_score);

              return (
                Number.isFinite(homeScore) &&
                Number.isFinite(awayScore)
              );
            })
            .sort((a, b) => {
              const ta = Number(a.time?.timestamp || 0);
              const tb = Number(b.time?.timestamp || 0);
              return tb - ta;
            });

          const recent = finished.slice(0, 5);

          if (!recent.length) {
            const result = {
              form: "",
              goals: 0,
              conceded: 0,
              matches: 0,
              hasData: false,
              error: "No valid finished SoccerSAPI matches found",
              sportSapiTeamId: team.id,
              teamName: team.name,
              source: "soccersapi"
            };

            if (cache) cache.set(cacheKey, result);

            return result;
          }

          let goals = 0;
          let conceded = 0;
          let form = "";

          const recentMatches = [];

          for (const fixture of recent) {
            const home = fixture.teams?.home || {};
            const away = fixture.teams?.away || {};
            const scores = fixture.scores || {};

            const homeScore = Number(scores.home_score);
            const awayScore = Number(scores.away_score);

            const isHome =
              Number(home.id) === Number(team.id);

            const teamGoals =
              isHome ? homeScore : awayScore;

            const teamConceded =
              isHome ? awayScore : homeScore;

            let resultLetter = "D";

            if (teamGoals > teamConceded) {
              resultLetter = "W";
            } else if (teamGoals < teamConceded) {
              resultLetter = "L";
            }

            goals += teamGoals;
            conceded += teamConceded;
            form += resultLetter;

            recentMatches.push({
              fixtureId: fixture.id,
              date: fixture.time?.datetime || "",
              opponent:
                isHome
                  ? away.name || ""
                  : home.name || "",
              goals: teamGoals,
              conceded: teamConceded,
              result: resultLetter
            });
          }

          const matches = recent.length;

          const result = {
            form,
            goals: Number((goals / matches).toFixed(2)),
            conceded: Number((conceded / matches).toFixed(2)),
            matches,
            hasData: matches > 0,
            sportSapiTeamId: team.id,
            teamName: team.name,
            recentMatches,
            source: "soccersapi"
          };

          console.log(
            "===== SOCCERSAPI TEAM STATS RESULT =====",
            JSON.stringify({
              teamName,
              teamId: team.id,
              leagueId,
              seasonId: leagueConfig.seasonId,
              form: result.form,
              goals: result.goals,
              conceded: result.conceded,
              matches: result.matches
            })
          );

          if (cache) cache.set(cacheKey, result);

          return result;

        } catch (error) {
          const result = {
            form: "",
            goals: 0,
            conceded: 0,
            matches: 0,
            hasData: false,
            error:
              error instanceof Error
                ? error.message
                : "Unknown SoccerSAPI statistics error",
            sportSapiTeamId: team.id,
            source: "soccersapi"
          };

          if (cache) cache.set(cacheKey, result);

          return result;
        }
      }

      async function getHybridTeamStats(
        teamName,
        match,
        env,
        cache
      ) {
        const competitionId =
          String(match.competition ?? "");

        /*
         * =====================================================
         * 1️⃣ SOCCERSAPI
         * =====================================================
         */
        const soccerStats =
          await getSoccerSapiTeamStats(
            teamName,
            competitionId,
            env,
            cache
          );

        if (soccerStats.hasData) {
          return soccerStats;
        }

        console.log(
          "===== SOCCERSAPI FALLBACK FOOTBALL-DATA =====",
          JSON.stringify({
            teamName,
            competitionId,
            reason:
              soccerStats.error ||
              "No SoccerSAPI data"
          })
        );

        /*
         * =====================================================
         * 2️⃣ FOOTBALL-DATA.ORG
         * =====================================================
         *
         * Les IDs proviennent directement de /fixtures.
         */
        const footballDataTeamId =
          String(
            teamName === match.homeTeam
              ? match.homeTeamId ?? ""
              : match.awayTeamId ?? ""
          );

        const footballStats =
          await getFootballDataTeamStats(
            teamName,
            footballDataTeamId,
            env,
            cache
          );

        if (footballStats.hasData) {
          console.log(
            "===== FOOTBALL-DATA REAL STATS FOUND =====",
            JSON.stringify({
              teamName,
              footballDataTeamId,
              form: footballStats.form,
              goals: footballStats.goals,
              conceded: footballStats.conceded,
              matches: footballStats.matches
            })
          );

          return footballStats;
        }

        console.log(
          "===== FOOTBALL-DATA FALLBACK SPORTMONKS =====",
          JSON.stringify({
            teamName,
            footballDataTeamId,
            reason:
              footballStats.error ||
              "No Football-data statistics"
          })
        );

        /*
         * =====================================================
         * 3️⃣ SPORTMONKS
         * =====================================================
         */
        const sportMonksStats =
          await getSportMonksTeamStats(
            teamName,
            env,
            cache
          );

        if (sportMonksStats.hasData) {
          return sportMonksStats;
        }

        /*
         * =====================================================
         * 4️⃣ AUCUNE DONNÉE
         * =====================================================
         */
        return {
          form: "",
          goals: 0,
          conceded: 0,
          matches: 0,
          hasData: false,
          source: "none",
          error:
            [
              footballStats.error,
              sportMonksStats.error
            ]
              .filter(Boolean)
              .join(" | ") ||
            "No real team statistics found"
        };
      }

      async function enrichMatchWithRealStats(match, env, cache) {
        /*
         * =====================================================
         * 📊 ENRICHISSEMENT HYBRIDE
         * =====================================================
         *
         * Priorité :
         *
         * 1. SoccerSAPI
         * 2. SportMonks en fallback
         *
         * Les statistiques sont recherchées à partir
         * du nom des équipes.
         */

        const homeStats = await getHybridTeamStats(
          match.homeTeam,
          match,
          env,
          cache
        );

        const awayStats = await getHybridTeamStats(
          match.awayTeam,
          match,
          env,
          cache
        );

        const homeHasData =
          homeStats.hasData === true;

        const awayHasData =
          awayStats.hasData === true;

        const hasRealStats =
          homeHasData && awayHasData;

        const statsComplete =
          homeHasData && awayHasData;

        const statsPartial =
          (homeHasData && !awayHasData) ||
          (!homeHasData && awayHasData);

        /*
         * =====================================================
         * 🔎 TRACE HYBRIDE
         * =====================================================
         */

        console.log(
          "===== HYBRID REAL STATS TRACE =====",
          JSON.stringify({
            match:
              `${match.homeTeam} vs ${match.awayTeam}`,

            competition:
              match.competition || null,

            homeTeam:
              match.homeTeam,

            awayTeam:
              match.awayTeam,

            homeSource:
              homeStats.source || null,

            awaySource:
              awayStats.source || null,

            homeSportSapiTeamId:
              homeStats.sportSapiTeamId ||
              null,

            awaySportSapiTeamId:
              awayStats.sportSapiTeamId ||
              null,

            homeSportMonksId:
              homeStats.sportmonksTeamId ||
              null,

            awaySportMonksId:
              awayStats.sportmonksTeamId ||
              null,

            homeHasData,
            awayHasData,

            hasRealStats,
            statsComplete,
            statsPartial,

            homeMatches:
              homeStats.matches || 0,

            awayMatches:
              awayStats.matches || 0,

            homeForm:
              homeStats.form || "",

            awayForm:
              awayStats.form || "",

            homeGoals:
              homeStats.goals ?? null,

            awayGoals:
              awayStats.goals ?? null,

            homeConceded:
              homeStats.conceded ?? null,

            awayConceded:
              awayStats.conceded ?? null,

            homeError:
              homeStats.error || null,

            awayError:
              awayStats.error || null
          })
        );

        /*
         * =====================================================
         * 📦 OBJET ENRICHI
         * =====================================================
         */

        return {
          ...match,

          homeForm:
            homeStats.form || "",

          awayForm:
            awayStats.form || "",

          homeGoals:
            homeHasData
              ? homeStats.goals
              : null,

          awayGoals:
            awayHasData
              ? awayStats.goals
              : null,

          homeConceded:
            homeHasData
              ? homeStats.conceded
              : null,

          awayConceded:
            awayHasData
              ? awayStats.conceded
              : null,

          /*
           * =====================================================
           * 📊 STATS
           *
           * IMPORTANT :
           * analyzeMatch() lit homeHasData / awayHasData
           * dans input.stats.
           * =====================================================
           */

          stats: {
            homeMatches:
              homeStats.matches || 0,

            awayMatches:
              awayStats.matches || 0,

            homeHasData,

            awayHasData,

            homeSource:
              homeStats.source || null,

            awaySource:
              awayStats.source || null,

            homeError:
              homeStats.error || null,

            awayError:
              awayStats.error || null
          },

          /*
           * =====================================================
           * 🔍 DEBUG
           * =====================================================
           */

          debugStats: {
            homeHasData,
            awayHasData,

            homeMatches:
              homeStats.matches || 0,

            awayMatches:
              awayStats.matches || 0,

            homeSource:
              homeStats.source || null,

            awaySource:
              awayStats.source || null,

            homeSportSapiTeamId:
              homeStats.sportSapiTeamId ||
              null,

            awaySportSapiTeamId:
              awayStats.sportSapiTeamId ||
              null,

            homeSportMonksId:
              homeStats.sportmonksTeamId ||
              null,

            awaySportMonksId:
              awayStats.sportmonksTeamId ||
              null,

            homeError:
              homeStats.error || null,

            awayError:
              awayStats.error || null
          },

          /*
           * =====================================================
           * ✅ QUALITÉ DES DONNÉES
           * =====================================================
           */

          hasRealStats,

          statsComplete,

          statsPartial
        };
      }

      async function enrichMatchesWithRealStats(matches, env, cache = new Map()) {
        const enriched = [];

        for (const match of matches) {
          try {
            const result =
              await enrichMatchWithRealStats(match, env, cache);

            enriched.push(result);
          } catch (error) {
            enriched.push({
              ...match,
              homeForm: "",
              awayForm: "",
              homeGoals: 0,
              awayGoals: 0,
              homeConceded: 0,
              awayConceded: 0,
              stats: {
                homeMatches: 0,
                awayMatches: 0
              },
              statsError:
                error instanceof Error
                  ? error.message
                  : "Unknown statistics error"
            });
          }
        }

        return enriched;
      }

      if (url.pathname === "/generate") {
        if (request.method !== "POST") {
          return corsResponse({ error: "Use POST /generate" }, 405, origin);
        }

        const admin = await requireFirebaseUser(request, env);
        const body = await request.json();

        if (Array.isArray(body.matches)) {
          if (body.matches.length < 1) {
            throw new Error("matches must contain at least one match");
          }

          // =====================================================
          // 📊 ENRICHISSEMENT AVEC LES VRAIES STATISTIQUES
          // =====================================================

          const statsCache = new Map();

          // =====================================================
          // ⚡ LIMITATION DES SOUS-REQUÊTES CLOUDFLARE
          // =====================================================
          // Le endpoint /fixtures peut retourner beaucoup de matchs.
          // Les statistiques nécessitent des requêtes supplémentaires.
          // On limite donc l'enrichissement à 15 matchs.
          // Le moteur choisira ensuite les 3 meilleurs.
          // =====================================================

          const MAX_STATS_MATCHES = 5;
          const selectedMatches = body.matches.slice(0, MAX_STATS_MATCHES);

          console.log(
            "MATCHS REÇUS:",
            body.matches.length,
            "| MATCHS ANALYSÉS:",
            selectedMatches.length
          );

          console.log("===== GENERATE INPUT TRACE =====", JSON.stringify(selectedMatches.map(m => ({ match: `${m.homeTeam} vs ${m.awayTeam}`, competition: m.competition, homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId }))));
          const enrichedMatches =
            await enrichMatchesWithRealStats(
              selectedMatches,
              env,
              statsCache
            );

          console.log(
            "STATS CACHE:",
            statsCache.size,
            "equipes uniques"
          );

          console.log(
            "REAL TEAM STATS DEBUG:",
            JSON.stringify(
              enrichedMatches.map(m => ({
                match: `${m.homeTeam} vs ${m.awayTeam}`,
                competition: m.competition,
                homeTeamId: m.homeTeamId,
                awayTeamId: m.awayTeamId,
                homeForm: m.homeForm,
                awayForm: m.awayForm,
                homeGoals: m.homeGoals,
                awayGoals: m.awayGoals,
                homeConceded: m.homeConceded,
                awayConceded: m.awayConceded,
                hasRealStats: m.hasRealStats,
                stats: m.stats
              }))
            )
          );

          console.log("===== ENRICHED STATS RESULT =====", JSON.stringify(enrichedMatches.map(m => ({ match: `${m.homeTeam} vs ${m.awayTeam}`, competition: m.competition, homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId, hasRealStats: m.hasRealStats, statsComplete: m.statsComplete, statsPartial: m.statsPartial, debugStats: m.debugStats, stats: m.stats }))));
          const analyses = enrichedMatches.map(analyzeMatch);

          console.log(
            "===== GENERATE STATS DIAGNOSTIC =====",
            JSON.stringify(
              enrichedMatches.map(m => ({
                match: `${m.homeTeam} vs ${m.awayTeam}`,
                competition: m.competition,
                homeTeamId: m.homeTeamId,
                awayTeamId: m.awayTeamId,
                hasRealStats: m.hasRealStats,
                statsComplete: m.statsComplete,
                statsPartial: m.statsPartial,
                debugStats: m.debugStats,
                stats: m.stats,
                homeForm: m.homeForm,
                awayForm: m.awayForm,
                homeGoals: m.homeGoals,
                awayGoals: m.awayGoals,
                homeConceded: m.homeConceded,
                awayConceded: m.awayConceded
              }))
            )
          );

          // =====================================================
          // 🧠 SÉLECTION VIP INTELLIGENTE
          // =====================================================
          // Priorité absolue aux statistiques réelles.
          // On garde seulement 5 matchs pour respecter
          // la limite de sous-requêtes Cloudflare.
          // =====================================================

          // =====================================================
          // 🧠 SÉLECTION VIP INTELLIGENTE
          // =====================================================
          // 2 équipes avec stats réelles = priorité maximale
          // 1 équipe avec stats réelles = accepté en complément
          // 0 équipe avec stats réelles = exclu
          // =====================================================

          const analysesWithStats = analyses
            .filter(item =>
              item.dataQuality?.dataSides >= 1
            )
            .sort((a, b) => {
              const sidesA = Number(a.dataQuality?.dataSides || 0);
              const sidesB = Number(b.dataQuality?.dataSides || 0);

              if (sidesB !== sidesA) {
                return sidesB - sidesA;
              }
              const completeA =
                a.dataQuality?.statsComplete === true ? 1 : 0;

              const completeB =
                b.dataQuality?.statsComplete === true ? 1 : 0;

              if (completeB !== completeA) {
                return completeB - completeA;
              }

              return Number(b.confidence || 0) -
                     Number(a.confidence || 0);
            });

          // 2 côtés avec statistiques + confiance >= 60
          const complete60 = analysesWithStats.filter(
            item =>
              item.dataQuality?.statsComplete === true &&
              Number(item.confidence || 0) >= 60
          );

          // Au moins 1 côté avec statistiques + confiance >= 60
          const stats60 = analysesWithStats.filter(
            item =>
              Number(item.confidence || 0) >= 60
          );

          // Au moins 1 côté avec statistiques + confiance >= 55
          const stats55 = analysesWithStats.filter(
            item =>
              Number(item.confidence || 0) >= 55
          );

          const best = [];

          function addDiversified(items) {
            for (const item of items) {
              if (best.length >= 3) break;
              if (best.includes(item)) continue;

              const sameMarket = best.filter(
                x => x.prediction === item.prediction
              ).length;

              if (sameMarket >= 1 && best.length < 2) {
                continue;
              }

              best.push(item);
            }
          }

          // 1️⃣ Priorité absolue : statistiques complètes
          addDiversified(complete60);

          // 2️⃣ Complément : statistiques réelles >= 60%
          if (best.length < 3) {
            addDiversified(stats60);
          }

          // 3️⃣ Complément : statistiques réelles >= 55%
          if (best.length < 3) {
            addDiversified(stats55);
          }

          // 4️⃣ Dernier secours : meilleurs matchs possédant
          // au moins une statistique réelle.
          if (best.length < 3) {
            for (const item of analysesWithStats) {
              if (best.length >= 3) break;

              if (!best.includes(item)) {
                best.push(item);
              }
            }
          }

          console.log(
            "VIP SELECTION:",
            "analyses=", analyses.length,
            "withStats=", analysesWithStats.length,
            "complete60=", complete60.length,
            "stats60=", stats60.length,
            "stats55=", stats55.length,
            "selected=", best.length
          );

          // Sécurité : aucun faux VIP sans statistiques réelles.
          if (best.length < 3) {
            throw new Error(
              `Le moteur IA n'a trouvé que ${best.length} pronostic(s) avec statistiques réelles sur ${analyses.length} matchs analysés`
            );
          }

          const formatPrediction = (p) =>
            p
              ? `${p.match} → ${p.prediction} (${p.confidence}%)`
              : "Aucun pronostic suffisamment fiable";

          const predictions = {
            aiMatch1: formatPrediction(best[0]),
            aiMatch2: formatPrediction(best[1]),
            aiMatch3: formatPrediction(best[2]),

            coupon1:
              best.length >= 2
                ? `${best[0].match} + ${best[1].match}`
                : "Coupon indisponible : pronostics fiables insuffisants",

            coupon2:
              best.length >= 3
                ? `${best[1].match} + ${best[2].match}`
                : "Coupon indisponible : 3 pronostics fiables insuffisants"
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


async function requireFirebaseUser(request, env) {
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
      body: JSON.stringify({ idToken })
    }
  );

  const data = await response.json();

  if (!response.ok || !data.users || !data.users.length) {
    throw new Error("Firebase ID token invalide");
  }

  const firebaseUser = data.users[0];

  return {
    uid: firebaseUser.localId,
    email: firebaseUser.email || ""
  };
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

  /*
   * =====================================================
   * 📊 QUALITÉ DES DONNÉES
   * =====================================================
   *
   * hasRealStats est ajouté par enrichMatchWithRealStats().
   * On ne doit jamais interpréter "0 donnée" comme
   * "l'équipe ne marque pas".
   */

  const homeHasData =
    input.stats?.homeHasData === true;

  const awayHasData =
    input.stats?.awayHasData === true;

  const hasRealStats =
    homeHasData && awayHasData;

  const statsPartial =
    (homeHasData && !awayHasData) ||
    (!homeHasData && awayHasData);

  const dataSides =
    (homeHasData ? 1 : 0) +
    (awayHasData ? 1 : 0);

  /*
   * =====================================================
   * 📈 FORMES ET FORCES
   * =====================================================
   */

  const homeFormScore = calculateFormScore(homeForm);
  const awayFormScore = calculateFormScore(awayForm);

  const homeAttack = calculateAttackScore(
    homeGoals,
    awayConceded
  );

  const awayAttack = calculateAttackScore(
    awayGoals,
    homeConceded
  );

  const homeDefense = calculateDefenseScore(
    homeConceded
  );

  const awayDefense = calculateDefenseScore(
    awayConceded
  );

  /*
   * =====================================================
   * ⚽ EXPECTED GOALS
   * =====================================================
   */

  let expectedGoals;

  if (hasRealStats) {
    expectedGoals = calculateExpectedGoals(
      homeGoals,
      awayGoals,
      homeConceded,
      awayConceded
    );
  } else if (dataSides === 1) {
    /*
     * Une seule équipe connue :
     * on utilise une estimation neutre au lieu de 0.
     */
    expectedGoals = 2.5;
  } else {
    /*
     * Aucune donnée :
     * 2.5 est une base neutre.
     * Surtout pas 0.
     */
    expectedGoals = 2.5;
  }

  expectedGoals = clamp(expectedGoals, 0.5, 5);

  /*
   * =====================================================
   * 🎯 SCORE EXACT
   * =====================================================
   */

  const exactScore = hasRealStats
    ? calculateExactScore(
        homeGoals,
        awayGoals,
        homeConceded,
        awayConceded
      )
    : {
        score: "1-1",
        probability: 25,
        homeExpectedGoals: 1.25,
        awayExpectedGoals: 1.25
      };

  /*
   * =====================================================
   * 📊 MARCHÉS
   * =====================================================
   */

  let bttsScore;
  let over25Score;
  let under35Score;
  let homeWinScore;

  if (hasRealStats) {
    bttsScore = calculateBttsScore(
      homeGoals,
      awayGoals,
      homeConceded,
      awayConceded
    );

    over25Score =
      calculateOver25Score(expectedGoals);

    under35Score =
      calculateUnder35Score(expectedGoals);

    homeWinScore = calculateHomeWinScore(
      homeFormScore,
      awayFormScore,
      homeAttack,
      awayAttack,
      homeDefense,
      awayDefense
    );

  } else if (dataSides === 1) {
    /*
     * Données partielles :
     * on évite les valeurs extrêmes.
     */

    bttsScore = 55;
    over25Score = 50;
    under35Score = 55;

    homeWinScore = 50;

  } else {
    /*
     * Aucune statistique réelle :
     * tous les marchés sont neutres.
     *
     * Cela empêche UNDER 3.5 de gagner avec 100%
     * simplement parce que les valeurs manquent.
     */

    bttsScore = 50;
    over25Score = 50;
    under35Score = 50;
    homeWinScore = 50;
  }

  /*
   * Sécurité supplémentaire :
   * UNDER 3.5 ne peut pas atteindre 100%
   * lorsque les statistiques réelles sont absentes.
   */

  if (!hasRealStats) {
    under35Score = Math.min(
      under35Score,
      dataSides === 1 ? 58 : 52
    );

    over25Score = Math.min(
      over25Score,
      dataSides === 1 ? 58 : 52
    );

    bttsScore = Math.min(
      bttsScore,
      dataSides === 1 ? 58 : 52
    );
  }

  /*
   * =====================================================
   * 🏆 CANDIDATS
   * =====================================================
   */

  const candidates = [
    {
      prediction: "BTTS",
      market: "Both Teams To Score",
      score: bttsScore
    },
    {
      prediction: "OVER 2.5",
      market: "Total Goals",
      score: over25Score
    },
    {
      prediction: "UNDER 3.5",
      market: "Total Goals",
      score: under35Score
    },
    {
      prediction: "1X",
      market: "Double Chance",
      score: homeWinScore
    },
    {
      prediction: "X2",
      market: "Double Chance",
      score: 100 - homeWinScore
    }
  ];

  candidates.sort(
    (a, b) => b.score - a.score
  );

  const best = candidates[0];

  /*
   * =====================================================
   * 🔐 CONFIANCE
   * =====================================================
   */

  let confidence = calculateConfidence(
    best.score,
    homeFormScore,
    awayFormScore,
    homeGoals,
    awayGoals,
    homeConceded,
    awayConceded
  );

  /*
   * Si les données sont absentes, la confiance doit
   * refléter cette incertitude.
   */

  if (dataSides === 0) {
    confidence = Math.min(confidence, 45);
  } else if (dataSides === 1) {
    confidence = Math.min(confidence, 58);
  } else if (!hasRealStats) {
    confidence = Math.min(confidence, 60);
  }

  /*
   * Évite également les faux scores très élevés
   * lorsque le marché est simplement neutre.
   */

  if (!hasRealStats && best.score <= 55) {
    confidence = Math.min(
      confidence,
      dataSides === 0 ? 45 : 55
    );
  }

  const risk =
    confidence >= 80
      ? "LOW"
      : confidence >= 65
        ? "MEDIUM"
        : "HIGH";

  return {
    match: `${homeTeam} vs ${awayTeam}`,

    homeTeam,
    awayTeam,

    prediction: best.prediction,
    market: best.market,

    confidence,
    risk,

    dataQuality: {
      hasRealStats,
      homeHasData,
      awayHasData,
      statsComplete: hasRealStats,
      statsPartial,
      dataSides
    },

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
      exactScoreProbability:
        exactScore.probability,

      homeExpectedGoals:
        exactScore.homeExpectedGoals,

      awayExpectedGoals:
        exactScore.awayExpectedGoals
    },

    recommendation:
      `${homeTeam} vs ${awayTeam} → ` +
      `${best.prediction} (${confidence}% confidence)`
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
      console.log("===== FIRESTORE UPDATE TRACE =====", JSON.stringify({ status: response.status, ok: response.ok, response: text.slice(0, 500) }));

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
