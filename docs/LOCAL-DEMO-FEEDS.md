# Local demo feeds

The optional local demo server provides synthetic JSON records for interface development and demonstrations.

- Bind address: `127.0.0.1` only
- Default port: `4174`
- Start in the foreground: `npm run mock:server`
- Install as a persistent Linux user service: `./scripts/install-local-demo-service.sh`
- Health: `GET /health`
- Combined feed: `GET /api/all`
- Individual feeds: `/api/aircraft`, `/api/ships`, `/api/fires`, `/api/traffic`, `/api/earthquakes`
- Verify: `npm run mock:test`

**Every returned record is invented test data.** The service does not connect to or impersonate OpenSky, AISStream, NASA FIRMS, TomTom, Google Maps, or any other upstream provider. Fire and earthquake markers are explicitly labeled synthetic and must never be used for emergency, dispatch, navigation, or operational decisions.

The mock server is a separate fixture API; it does not silently replace the application's real provider adapters. The main app remains keyless-capable and existing provider settings are unchanged.
