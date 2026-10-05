const session = require("express-session");

const SESSION_COOKIE = "metricmantis.sid";

const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
};

function sessionMiddleware() {
  return session({
    name: SESSION_COOKIE,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      ...cookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions);
}

module.exports = {
  SESSION_COOKIE,
  sessionMiddleware,
  clearSessionCookie,
};
