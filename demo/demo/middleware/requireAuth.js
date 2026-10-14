function requireAuth(req, res, next) {
  const sessionUser = req.session && req.session.user;

  if (!sessionUser || !sessionUser.userId) {
    return res.status(401).json({
      success: false,
      message: "Authentication required.",
      error: "Authentication required.",
    });
  }

  next();
}

module.exports = requireAuth;
