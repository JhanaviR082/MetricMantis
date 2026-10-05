const express = require("express");
const authService = require("../auth/authService");
const { clearSessionCookie } = require("../auth/session");

const router = express.Router();

router.post("/signup", async (req, res) => {
  try {
    await authService.signup(req.body);
    res.status(201).json({
      success: true,
      message: "Account created successfully.",
    });
  } catch (error) {
    if (error instanceof authService.AuthError) {
      return res.status(error.status).json({
        success: false,
        message: error.message,
      });
    }
    console.error("Signup error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to create an account right now.",
    });
  }
});

router.post("/login", async (req, res) => {
  try {
    const user = await authService.login(req.body);

    req.session.regenerate((regenerateError) => {
      if (regenerateError) {
        console.error("Session regenerate error:", regenerateError);
        return res.status(500).json({
          success: false,
          message: "Unable to start a session right now.",
        });
      }

      req.session.user = {
        userId: user.id,
        username: user.username,
      };

      req.session.save((saveError) => {
        if (saveError) {
          console.error("Session save error:", saveError);
          return res.status(500).json({
            success: false,
            message: "Unable to start a session right now.",
          });
        }

        res.json({
          success: true,
          message: "Logged in successfully.",
          user,
        });
      });
    });
  } catch (error) {
    if (error instanceof authService.AuthError) {
      return res.status(error.status).json({
        success: false,
        message: error.message,
      });
    }
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to log in right now.",
    });
  }
});

router.post("/logout", (req, res) => {
  const finish = () => {
    clearSessionCookie(res);
    res.json({
      success: true,
      message: "Logged out successfully.",
    });
  };

  if (!req.session) {
    return finish();
  }

  req.session.destroy((error) => {
    if (error) {
      console.error("Logout error:", error);
      return res.status(500).json({
        success: false,
        message: "Unable to log out right now.",
      });
    }
    finish();
  });
});

router.get("/me", (req, res) => {
  const sessionUser = req.session && req.session.user;
  if (!sessionUser || !sessionUser.userId) {
    return res.json({ authenticated: false });
  }

  const user = authService.getUserById(sessionUser.userId);
  if (!user) {
    return res.json({ authenticated: false });
  }

  res.json({
    authenticated: true,
    user,
  });
});

module.exports = router;
