const operation = (summary: string, secured = true) => ({
  summary,
  ...(secured ? { security: [{ bearerAuth: [] }] } : {}),
  responses: { '200': { description: 'Success' }, '202': { description: 'Accepted' } },
});

const identifiedOperation = (summary: string) => ({
  ...operation(summary),
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    },
  ],
});

export const kyqraOpenApi = {
  openapi: '3.1.0',
  info: { title: 'Kyqra Crawler API', version: '2.0.0' },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
  },
  paths: {
    '/health': { get: operation('Legacy readiness', false) },
    '/healthz': { get: operation('Legacy liveness', false) },
    '/readyz': { get: operation('Legacy readiness', false) },
    '/health/live': { get: operation('Liveness', false) },
    '/health/ready': { get: operation('Readiness', false) },
    '/api/v1/health': { get: operation('Legacy health', false) },
    '/api/v1/jobs': { post: operation('Legacy create job') },
    '/api/v1/jobs/{id}': { get: identifiedOperation('Legacy job detail') },
    '/api/v1/jobs/{id}/results': { get: identifiedOperation('Legacy job results') },
    '/api/v1/jobs/{id}/cancel': { post: identifiedOperation('Legacy cancel job') },
    '/api/v1/jobs/{id}/retry': { post: identifiedOperation('Legacy retry job') },
    '/api/v1/stats': { get: operation('Legacy operations statistics') },
    '/api/v1/webhooks/test': { post: operation('Legacy callback test') },
    '/v1/me': { get: operation('Current service identity') },
    '/v1/capabilities': { get: operation('Caller capabilities') },
    '/v1/jobs': { get: operation('List jobs'), post: operation('Create job') },
    '/v1/jobs/{id}': { get: identifiedOperation('Job detail') },
    '/v1/jobs/{id}/cancel': { post: identifiedOperation('Cancel job') },
    '/v1/jobs/{id}/retry': { post: identifiedOperation('Retry job') },
    '/v1/jobs/{id}/results': { get: identifiedOperation('Job results') },
    '/v1/jobs/{id}/events': { get: identifiedOperation('Job events') },
    '/v1/callbacks': { get: operation('List callbacks'), post: operation('Create callback') },
    '/v1/callbacks/{id}': { get: identifiedOperation('Callback detail') },
    '/v1/operations': { get: operation('List operations') },
    '/v1/operations/{id}': { get: identifiedOperation('Operation detail') },
    '/v1/operations/{id}/events': { get: identifiedOperation('Operation events') },
    '/v1/operations/{id}/attempts': { get: identifiedOperation('Operation attempts') },
    '/v1/operations/{id}/cancel': { post: identifiedOperation('Cancel operation') },
    '/v1/operations/{id}/reconcile': { post: identifiedOperation('Reconcile operation') },
    '/metrics': { get: operation('Prometheus metrics') },
    '/v1/system/readiness': { get: operation('System readiness') },
    '/openapi.json': { get: operation('OpenAPI document', false) },
  },
} as const;
