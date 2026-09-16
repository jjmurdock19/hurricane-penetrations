// penetration-tracker-api
//
// Public reads:
//   GET  /people
//   GET  /people/:id
//   GET  /people/:id/breakdown
//   GET  /people/:id/penetrations?year=2025|2026|current|all
//   GET  /leaderboard?year=current|all&limit=10
//   GET  /storms
//   GET  /missions?storm_id=1
//
// Admin writes (require header  X-Admin-Token: <ADMIN_TOKEN secret>):
//   POST /admin/people           { first_name, last_name, affiliation }
//   POST /admin/people/:id       { first_name?, last_name?, affiliation?, active? }  (update)
//   POST /admin/storms           { name, season_year }
//   POST /admin/missions         { storm_id, flight_designation, mission_date }
//   POST /admin/missions/:id/penetrations   { person_id, penetration_count }

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function resolveYear(yearParam: string | null): number | null {
  if (!yearParam || yearParam === "all") return null;
  if (yearParam === "current") return new Date().getFullYear();
  const y = parseInt(yearParam, 10);
  return Number.isNaN(y) ? null : y;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;
    const parts = pathname.split("/").filter(Boolean);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Every /admin/* write requires the shared admin token.
    if (parts[0] === "admin") {
      const provided = request.headers.get("X-Admin-Token");
      const expected = (env as any).ADMIN_TOKEN as string | undefined;
      if (!expected || provided !== expected) {
        return json({
          error: `unauthorized (token configured: ${!!expected}, expected length: ${expected ? expected.length : 0}, received length: ${provided ? provided.length : 0})`
        }, 401);
      }
    }


    try {
      // GET /people (full roster, for client-side autocomplete)
      if (request.method === "GET" && parts[0] === "people" && parts.length === 1) {
        const { results } = await env.DB.prepare(
          "SELECT id, first_name, last_name, affiliation FROM people ORDER BY last_name, first_name"
        ).all();
        return json({ people: results });
      }

      // GET /people/:id
      if (request.method === "GET" && parts[0] === "people" && parts.length === 2) {
        const person = await env.DB.prepare(
          "SELECT id, first_name, last_name, affiliation, active FROM people WHERE id = ?"
        ).bind(parts[1]).first();
        if (!person) return json({ error: "person not found" }, 404);
        return json(person);
      }

      // GET /people/:id/breakdown  (per-storm totals grouped by season, for one person)
      if (request.method === "GET" && parts[0] === "people" && parts[2] === "breakdown") {
        const query = `
          SELECT s.season_year, s.id AS storm_id, s.name AS storm_name,
                 SUM(p.penetration_count) AS penetration_count
          FROM penetrations p
          JOIN missions m ON m.id = p.mission_id
          JOIN storms s ON s.id = m.storm_id
          WHERE p.person_id = ?
          GROUP BY s.season_year, s.id
          ORDER BY s.season_year DESC, penetration_count DESC`;
        const { results } = await env.DB.prepare(query).bind(parts[1]).all();
        return json({ person_id: Number(parts[1]), breakdown: results });
      }

      // GET /people/:id/penetrations?year=
      if (request.method === "GET" && parts[0] === "people" && parts[2] === "penetrations") {
        const year = resolveYear(searchParams.get("year"));
        let query = `
          SELECT COALESCE(SUM(p.penetration_count), 0) AS total_penetrations
          FROM penetrations p
          JOIN missions m ON m.id = p.mission_id
          JOIN storms s ON s.id = m.storm_id
          WHERE p.person_id = ?`;
        const binds: (string | number)[] = [parts[1]];
        if (year !== null) {
          query += " AND s.season_year = ?";
          binds.push(year);
        }
        const result = await env.DB.prepare(query).bind(...binds).first();
        return json({ person_id: Number(parts[1]), year: year ?? "all", ...result });
      }

      // GET /leaderboard?year=&limit=
      if (request.method === "GET" && parts[0] === "leaderboard" && parts.length === 1) {
        const year = resolveYear(searchParams.get("year") ?? "current");
        const limit = Math.min(parseInt(searchParams.get("limit") ?? "10", 10) || 10, 100);
        let query = `
          SELECT pe.id AS person_id, pe.first_name, pe.last_name, pe.affiliation,
                 SUM(p.penetration_count) AS total_penetrations
          FROM penetrations p
          JOIN people pe ON pe.id = p.person_id
          JOIN missions m ON m.id = p.mission_id
          JOIN storms s ON s.id = m.storm_id`;
        const binds: (string | number)[] = [];
        if (year !== null) {
          query += " WHERE s.season_year = ?";
          binds.push(year);
        }
        query += " GROUP BY pe.id ORDER BY total_penetrations DESC LIMIT ?";
        binds.push(limit);
        const { results } = await env.DB.prepare(query).bind(...binds).all();
        return json({ year: year ?? "all", leaderboard: results });
      }

      // GET /storms
      if (request.method === "GET" && parts[0] === "storms" && parts.length === 1) {
        const { results } = await env.DB.prepare(
          "SELECT id, name, season_year FROM storms ORDER BY season_year DESC, name"
        ).all();
        return json({ storms: results });
      }

      // GET /missions?storm_id=
      if (request.method === "GET" && parts[0] === "missions" && parts.length === 1) {
        const stormId = searchParams.get("storm_id");
        let query = "SELECT id, storm_id, flight_designation, mission_date FROM missions";
        const binds: (string | number)[] = [];
        if (stormId) {
          query += " WHERE storm_id = ?";
          binds.push(stormId);
        }
        query += " ORDER BY mission_date DESC";
        const { results } = await env.DB.prepare(query).bind(...binds).all();
        return json({ missions: results });
      }

      // POST /admin/people
      if (request.method === "POST" && parts[0] === "admin" && parts[1] === "people" && parts.length === 2) {
        const body: any = await request.json();
        if (!body.first_name || !body.last_name) {
          return json({ error: "first_name and last_name are required" }, 400);
        }
        const result = await env.DB.prepare(
          "INSERT INTO people (first_name, last_name, affiliation) VALUES (?, ?, ?)"
        ).bind(body.first_name, body.last_name, body.affiliation ?? null).run();
        return json({ id: result.meta.last_row_id }, 201);
      }

      // POST /admin/people/:id  (update)
      if (request.method === "POST" && parts[0] === "admin" && parts[1] === "people" && parts.length === 3) {
        const body: any = await request.json();
        const fields: string[] = [];
        const binds: (string | number | null)[] = [];
        if (body.first_name !== undefined) { fields.push("first_name = ?"); binds.push(body.first_name); }
        if (body.last_name !== undefined) { fields.push("last_name = ?"); binds.push(body.last_name); }
        if (body.affiliation !== undefined) { fields.push("affiliation = ?"); binds.push(body.affiliation); }
        if (body.active !== undefined) { fields.push("active = ?"); binds.push(body.active ? 1 : 0); }
        if (fields.length === 0) {
          return json({ error: "no fields to update" }, 400);
        }
        binds.push(parts[2]);
        await env.DB.prepare(`UPDATE people SET ${fields.join(", ")} WHERE id = ?`).bind(...binds).run();
        return json({ id: Number(parts[2]) }, 200);
      }

      // POST /admin/storms
      if (request.method === "POST" && parts[0] === "admin" && parts[1] === "storms") {
        const body: any = await request.json();
        if (!body.name || !body.season_year) {
          return json({ error: "name and season_year are required" }, 400);
        }
        const result = await env.DB.prepare(
          "INSERT INTO storms (name, season_year) VALUES (?, ?)"
        ).bind(body.name, body.season_year).run();
        return json({ id: result.meta.last_row_id }, 201);
      }

      // POST /admin/missions
      if (request.method === "POST" && parts[0] === "admin" && parts[1] === "missions" && parts.length === 2) {
        const body: any = await request.json();
        if (!body.storm_id) {
          return json({ error: "storm_id is required" }, 400);
        }
        const result = await env.DB.prepare(
          "INSERT INTO missions (storm_id, flight_designation, mission_date) VALUES (?, ?, ?)"
        ).bind(body.storm_id, body.flight_designation ?? null, body.mission_date ?? null).run();
        return json({ id: result.meta.last_row_id }, 201);
      }

      // POST /admin/missions/:id/penetrations
      if (request.method === "POST" && parts[0] === "admin" && parts[1] === "missions" && parts[3] === "penetrations") {
        const body: any = await request.json();
        if (!body.person_id || body.penetration_count === undefined) {
          return json({ error: "person_id and penetration_count are required" }, 400);
        }
        const result = await env.DB.prepare(
          "INSERT INTO penetrations (mission_id, person_id, penetration_count) VALUES (?, ?, ?)"
        ).bind(parts[2], body.person_id, body.penetration_count).run();
        return json({ id: result.meta.last_row_id }, 201);
      }

      return json({ error: "not found" }, 404);
    } catch (err: any) {
      return json({ error: err.message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

// NOTE ON ADMIN ROUTES:
// /admin/* writes require a shared secret sent as the X-Admin-Token header,
// checked against the ADMIN_TOKEN Worker secret above. Set it with:
//   wrangler secret put ADMIN_TOKEN
// The admin console (Apps Script, in the hurricane_pennie_tracker_pages repo's
// admin/ folder) asks for a password, and on success hands the browser this
// same token to attach to its write requests -- the password itself never
// leaves the Apps Script server.
