  // POST /api/photos/upload — host uploads a listing photo to R2
  if (pathname === '/api/photos/upload' && request.method === 'POST') {
    return uploadPhoto(request, env);
  }

  // TEMPORARY DEBUG — remove once admin login is fixed. Reveals no
  // actual values, just lengths/presence, to diagnose a mismatch.
  if (pathname === '/api/admin/debug' && request.method === 'GET') {
    const headerValue = request.headers.get('X-Admin-Password');
    return json({
      headerReceived: headerValue !== null,
      headerLength: headerValue ? headerValue.length : 0,
      secretIsSet: typeof env.ADMIN_PASSWORD === 'string',
      secretLength: env.ADMIN_PASSWORD ? env.ADMIN_PASSWORD.length : 0,
      exactMatch: headerValue === env.ADMIN_PASSWORD,
    });
  }

  return json({ error: 'Not found' }, 404);
}
