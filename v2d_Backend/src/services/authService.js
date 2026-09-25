import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { query, withTransaction } from "../config/db.js";
import { env } from "../config/env.js";

export const authService = {
  async register({
    username,
    email,
    password,
    role,
    hostelId,
    studentDetails,
  }) {
    return await withTransaction(async (client) => {
      // 1. Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // 2. Insert into users table
      const userRes = await client.query(
        `INSERT INTO users (username, email, hashed_password, role, hostel_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, email, role, hostel_id, is_active, created_at`,
        [username, email, hashedPassword, role, hostelId || null],
      );
      const user = userRes.rows[0];

      let student = null;
      let messId = null;

      // 3. If user is STUDENT, create student record
      if (role === "STUDENT") {
        if (
          !studentDetails ||
          !studentDetails.messId ||
          !studentDetails.rollNumber ||
          !studentDetails.name
        ) {
          throw {
            statusCode: 400,
            message:
              "Student registration requires name, rollNumber, and messId",
          };
        }
        const studentRes = await client.query(
          `INSERT INTO students (user_id, hostel_id, mess_id, name, roll_number, room_number)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, hostel_id, mess_id, name, roll_number, room_number, enrolled, consecutive_no_shows, total_penalties`,
          [
            user.id,
            hostelId || studentDetails.hostelId,
            studentDetails.messId,
            studentDetails.name,
            studentDetails.rollNumber,
            studentDetails.roomNumber || null,
          ],
        );
        student = studentRes.rows[0];
        messId = student.mess_id;
      } else if (role === "SUPERVISOR") {
        // Find default mess for supervisor's hostel if available
        if (hostelId) {
          const messRes = await client.query(
            `SELECT id FROM messes WHERE hostel_id = $1 LIMIT 1`,
            [hostelId],
          );
          if (messRes.rows.length > 0) {
            messId = messRes.rows[0].id;
          }
        }
      }

      // 4. Generate JWT
      const tokenPayload = {
        userId: user.id,
        username: user.username,
        role: user.role,
        hostelId: user.hostel_id,
        studentId: student ? student.id : null,
        messId: messId,
      };

      const token = jwt.sign(tokenPayload, env.JWT.secret, {
        expiresIn: env.JWT.expiresIn,
      });

      return { user, student, token };
    });
  },

  async login({ username, password }) {
    // 1. Fetch user by username
    const userRes = await query(`SELECT * FROM users WHERE username = $1`, [
      username,
    ]);
    if (userRes.rows.length === 0) {
      throw { statusCode: 401, message: "Invalid username or password" };
    }

    const user = userRes.rows[0];
    if (!user.is_active) {
      throw { statusCode: 403, message: "Account is deactivated" };
    }

    // 2. Validate password
    const isMatch = await bcrypt.compare(password, user.hashed_password);
    if (!isMatch) {
      throw { statusCode: 401, message: "Invalid username or password" };
    }

    let student = null;
    let messId = null;

    // 3. Fetch student profile if STUDENT role
    if (user.role === "STUDENT") {
      const studentRes = await query(
        `SELECT * FROM students WHERE user_id = $1`,
        [user.id],
      );
      if (studentRes.rows.length > 0) {
        student = studentRes.rows[0];
        messId = student.mess_id;
      }
    } else if (user.role === "SUPERVISOR" && user.hostel_id) {
      const messRes = await query(
        `SELECT id FROM messes WHERE hostel_id = $1 LIMIT 1`,
        [user.hostel_id],
      );
      if (messRes.rows.length > 0) {
        messId = messRes.rows[0].id;
      }
    }

    // 4. Sign JWT token
    const tokenPayload = {
      userId: user.id,
      username: user.username,
      role: user.role,
      hostelId: user.hostel_id,
      studentId: student ? student.id : null,
      messId: messId,
    };

    const token = jwt.sign(tokenPayload, env.JWT.secret, {
      expiresIn: env.JWT.expiresIn,
    });

    delete user.hashed_password;

    return { user, student, token };
  },

  async getMe(userId) {
    const userRes = await query(
      `SELECT id, username, email, role, hostel_id, is_active, created_at FROM users WHERE id = $1`,
      [userId],
    );
    if (userRes.rows.length === 0) {
      throw { statusCode: 44, message: "User profile not found" };
    }

    const user = userRes.rows[0];
    let student = null;

    if (user.role === "STUDENT") {
      const studentRes = await query(
        `SELECT * FROM students WHERE user_id = $1`,
        [user.id],
      );
      if (studentRes.rows.length > 0) {
        student = studentRes.rows[0];
      }
    }

    return { user, student };
  },
};
