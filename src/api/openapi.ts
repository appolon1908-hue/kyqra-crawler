const successResponses = {
  '200': { description: 'Success' },
  '201': { description: 'Created' },
  '202': { description: 'Durable command accepted' },
};

const operation = (summary: string, secured = true) => ({
  summary,
  ...(secured ? { security: [{ bearerAuth: [] }] } : { security: [] }),
  responses: successResponses,
});

const idParameter = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

const commandHeaders = [
  {
    name: 'Idempotency-Key',
    in: 'header',
    required: true,
    schema: { type: 'string', minLength: 8, maxLength: 128 },
  },
  {
    name: 'X-Correlation-Id',
    in: 'header',
    required: true,
    schema: { type: 'string', minLength: 8, maxLength: 128 },
  },
];

const identifiedOperation = (summary: string) => ({
  ...operation(summary),
  parameters: [idParameter],
});

const command = (summary: string) => ({
  ...operation(summary),
  parameters: commandHeaders,
  responses: {
    ...successResponses,
    '409': { description: 'State or idempotency conflict' },
  },
});

const identifiedCommand = (summary: string) => ({
  ...command(summary),
  parameters: [idParameter, ...commandHeaders],
});

export const kyqraOpenApi = {
  openapi: '3.1.0',
  info: { title: 'Kyqra Crawler API', version: '2.0.0' },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
  },
  paths: {
    '/': { get: operation('Crawler dashboard', false) },
    '/health': { get: operation('Legacy readiness', false) },
    '/healthz': { get: operation('Legacy liveness', false) },
    '/readyz': { get: operation('Legacy readiness', false) },
    '/health/live': { get: operation('Liveness', false) },
    '/health/ready': { get: operation('Readiness', false) },
    '/api/v1/health': { get: operation('Legacy API liveness', false) },
    '/openapi.json': { get: operation('Canonical OpenAPI document', false) },

    '/api/v1/jobs': { post: command('Legacy create crawl job') },
    '/api/v1/jobs/{id}': { get: identifiedOperation('Legacy job detail') },
    '/api/v1/jobs/{id}/results': { get: identifiedOperation('Legacy job results') },
    '/api/v1/jobs/{id}/cancel': { post: identifiedCommand('Legacy cancel job') },
    '/api/v1/jobs/{id}/retry': { post: identifiedCommand('Legacy retry job') },
    '/api/v1/stats': {
      get: { ...operation('Queue and worker statistics'), 'x-required-roles': ['operations'] },
    },
    '/api/v1/webhooks/test': {
      post: {
        ...command('Queue controlled webhook test'),
        'x-required-roles': ['operations'],
      },
    },

    '/v1/me': { get: operation('Current service identity') },
    '/v1/capabilities': { get: operation('Caller capabilities') },
    '/v1/jobs': {
      get: operation('List tenant jobs'),
      post: {
        ...command('Create crawl job'),
        responses: {
          ...successResponses,
          '409': { description: 'Idempotency conflict' },
          '429': { description: 'Tenant rate limit exceeded' },
        },
      },
    },
    '/v1/jobs/{id}': { get: identifiedOperation('Job detail') },
    '/v1/jobs/{id}/cancel': { post: identifiedCommand('Cancel job') },
    '/v1/jobs/{id}/retry': { post: identifiedCommand('Retry failed job') },
    '/v1/jobs/{id}/results': { get: identifiedOperation('Job results') },
    '/v1/jobs/{id}/events': { get: identifiedOperation('Durable job events') },
    '/v1/callbacks': {
      get: operation('List callback configurations'),
      post: command('Create callback configuration'),
    },
    '/v1/callbacks/{id}': { get: identifiedOperation('Callback detail') },
    '/v1/operations': { get: operation('List durable operations') },
    '/v1/operations/{id}': { get: identifiedOperation('Operation detail') },
    '/v1/operations/{id}/events': { get: identifiedOperation('Operation events') },
    '/v1/operations/{id}/attempts': { get: identifiedOperation('Operation attempts') },
    '/v1/operations/{id}/cancel': { post: identifiedCommand('Cancel operation') },
    '/v1/operations/{id}/reconcile': { post: identifiedCommand('Reconcile operation') },
    '/metrics': {
      get: { ...operation('Prometheus metrics'), 'x-required-roles': ['operations'] },
    },
    '/v1/system/readiness': { get: operation('System readiness') },
  },
} as const;
