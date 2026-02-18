if (!process.env.ADMIN_API_KEY) {
  console.warn("WARNING: ADMIN_API_KEY is not configured — admin routes will reject all requests");
}

export const requireAdminKey = (req, res, next) => {

  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing admin key' });
  }

  const key = header.replace('Bearer ', '').trim();

  if (key !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({ error: 'invalid admin key' });
  }

  next();
};
