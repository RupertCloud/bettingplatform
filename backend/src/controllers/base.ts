import * as fs from "fs";
import * as crypto from "crypto";
import * as geoip from "geoip-country";
import * as requestIp from "request-ip";
import * as nodemailer from "nodemailer";
import * as moment from "moment-timezone";
import mongoose, { ObjectId as ObjectIdType } from "mongoose";
import { Request, Response, NextFunction } from "express";
import { RateLimiterMongo } from "rate-limiter-flexible";
import {
  BalanceHistories,
  Balances,
  Currencies,
  Games,
  Sessions,
  SportsBets,
  Users,
} from "../models";
const V2 = require("recaptcha-v2");
const config = require("../../config");

export const maxFailsByLogin = 10000;
const mongoConn = mongoose.connection;
const usernameOpts = {
  storeClient: mongoConn,
  keyPrefix: "login_fail_username",
  points: maxFailsByLogin,
  duration: 60 * 60 * 3,
  blockDuration: 60 * 15,
};
const ipOpts = {
  storeClient: mongoConn,
  keyPrefix: "login_fail_ip",
  points: maxFailsByLogin,
  duration: 60 * 60 * 3,
  blockDuration: 60 * 15,
};
export const usernameLimiter = new RateLimiterMongo(usernameOpts);
export const ipLimiter = new RateLimiterMongo(ipOpts);

export const getIpKey = (req: Request): string =>
  req.ip ?? requestIp.getClientIp(req) ?? "unknown";

export const checkLimiter = async (req: Request, res: Response) => {
  try {
    await ipLimiter.consume(getIpKey(req));
    await usernameLimiter.consume(req.body.email);
  } catch (rlRejected) {
    if (rlRejected instanceof Error) {
    } else {
      // res.set('Retry-After', String(Math.round(rlRejected.msBeforeNext / 1000)) || 1)
      return res.status(429).send("Too Many Requests");
    }
  }
};

export const ObjectId = (id: string) => {
  try {
    return new mongoose.Types.ObjectId(id);
  } catch (error) {
    console.log("ObjectId", id);
  }
};

export const globalTime = () => {
  return moment.tz(new Date(), process.env.TIME_ZONE as string);
};

export const getSessionTime = () => {
  const time = new Date(
    new Date().valueOf() + parseInt(process.env.SESSION as string)
  );
  return moment.tz(time, process.env.TIME_ZONE as string);
};

export const encrypt = (text: string) => {
  let iv = crypto.randomBytes(Number(process.env.IV_LENGTH));
  let cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(process.env.ENCRYPTION_KEY as string),
    iv
  );
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + "::" + encrypted.toString("hex");
};

export const decrypt = (text: string): string => {
  try {
    let textParts = text.split("::");
    let iv = Buffer.from(textParts.shift() as string, "hex");
    let encryptedText = Buffer.from(textParts.join("::"), "hex");
    let decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      Buffer.from(process.env.ENCRYPTION_KEY as string),
      iv
    );
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (e) {
    return "";
  }
};

export const getIPAddress = (req: Request) => {
  let ip = requestIp.getClientIp(req);
  if (ip) {
    ip = ip.replace("::ffff:", "");
  }
  const geo = geoip.lookup(ip as string);
  return { ip, useragent: req.useragent, ...geo };
};

// Unguessable token from a CSPRNG (SRS SEC-AUTH-003).
export const newToken = (): string => crypto.randomBytes(32).toString("hex");

// Case-insensitive exact match; escapes user input so it is never read as a
// regex pattern (SRS FR-ACC-004).
export const exactMatch = (value: string): RegExp =>
  new RegExp("^" + String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");

export const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export const signAccessToken = (
  req: Request,
  res: Response,
  userId: string
): any => {
  try {
    if (userId) {
      const expiration = getSessionTime();
      const accessToken = newToken();
      const refreshToken = newToken();
      const ip = getIPAddress(req);
      return { accessToken, refreshToken, expiration, userId, ...ip };
    }
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
};

export const dataSave = async (data: any, model: any) => {
  const savehandle = new model(data);
  return await savehandle.save().then((result: any) => {
    if (!result) {
      return false;
    } else {
      return result;
    }
  });
};

export const NumberFix = (number: number, decimal = 10): number => {
  return Number(Number(number).toFixed(decimal));
};

export const handleBet = async ({
  req = undefined,
  userId,
  amount,
  currency,
  type,
  info = "",
  status = false,
}: {
  req?: any | undefined;
  userId: string;
  amount: number;
  currency: string;
  type: string;
  info: string;
  status?: boolean | undefined;
}) => {
  const user = await Users.findById(ObjectId(userId));
  if (status && user?.rReferral && user.rReferral !== "") {
    const rUser: any = await Users.findOne({ iReferral: user.rReferral });
    const userId1 = ObjectId(userId);
    const userId2 = ObjectId(rUser._id);
    const amount1 = NumberFix(amount);
    const amount2 = NumberFix(amount * (rUser.pReferal || 0.02));
    const result1: any = await Balances.findOneAndUpdate(
      { userId: userId1, currency: ObjectId(currency) },
      { $inc: { balance: amount1 } },
      { new: true }
    );
    const result2: any = await Balances.findOneAndUpdate(
      { userId: userId2, currency: ObjectId(currency) },
      { $inc: { balance: amount2 } },
      { new: true, upsert: true }
    );
    const currentBalance1 = NumberFix(result1.balance);
    const beforeBalance1 = NumberFix(result1.balance - amount);
    const currentBalance2 = NumberFix(result2.balance);
    const beforeBalance2 = NumberFix(result2.balance - amount);
    await BalanceHistories.create({
      userId: userId1,
      amount: amount1,
      currency,
      type,
      currentBalance: currentBalance1,
      beforeBalance: beforeBalance1,
      info,
    });
    await BalanceHistories.create({
      userId: userId2,
      amount: amount2,
      currency,
      type: "referral-bonus",
      currentBalance: currentBalance2,
      beforeBalance: beforeBalance2,
      info,
    });
    if (result1.status && !result1.disabled && req) {
      const session = await Sessions.findOne({ userId });
      req.app
        .get("io")
        .to(session?.socketId)
        .emit("balance", { balance: result1.balance });
    }
    return result1;
  } else {
    const result: any = await Balances.findOneAndUpdate(
      { userId: ObjectId(userId), currency: ObjectId(currency) },
      { $inc: { balance: NumberFix(amount) } },
      { new: true }
    );
    const currentBalance = NumberFix(result.balance);
    const beforeBalance = NumberFix(result.balance - amount);
    await BalanceHistories.create({
      userId,
      amount,
      currency,
      type,
      currentBalance,
      beforeBalance,
      info,
    });
    if (result.status && !result.disabled && req) {
      const session = await Sessions.findOne({ userId });
      req.app
        .get("io")
        .to(session?.socketId)
        .emit("balance", { balance: result.balance });
    }
    return result;
  }
};

export const balanceUpdate = async ({
  req,
  balanceId,
  amount,
  type,
}: {
  req?: any | undefined;
  balanceId: string;
  amount: number;
  type: string;
}) => {
  const result: any = await Balances.findOneAndUpdate(
    { _id: ObjectId(balanceId) },
    { $inc: { balance: NumberFix(amount) } },
    { new: true }
  );
  const currentBalance = NumberFix(result.balance);
  const beforeBalance = NumberFix(result.balance - amount);
  await BalanceHistories.create({
    userId: result.userId,
    currency: result.currency,
    amount: NumberFix(amount),
    type,
    currentBalance,
    beforeBalance,
    info: new Date().getTime() + Math.random(),
  });
  if (result.status && !result.disabled && req) {
    const session = await Sessions.findOne({ userId: result.userId });
    if (session && session.socketId)
      req.app
        .get("io")
        .to(session.socketId)
        .emit("balance", { balance: result.balance });
  }
  return result;
};

export const getActiveBet = async ({
  userId,
  currency,
  amount,
}: {
  userId: string;
  currency: string;
  amount: number;
}) => {
  const data: any = await Currencies.findById(ObjectId(currency)).select({
    betLimit: 1,
  });
  const result = await SportsBets.aggregate([
    {
      $match: {
        userId: ObjectId(userId),
        currency: ObjectId(currency),
        status: "BET",
      },
    },
    {
      $group: {
        _id: "stake",
        stake: { $sum: "$stake" },
      },
    },
    {
      $unwind: "$stake",
    },
  ]);
  if (!result.length) {
    return true;
  } else if (data.betLimit - result[0]?.stake - amount > 0) {
    return true;
  } else {
    return false;
  }
};

export const checkMaxBet = async ({
  currency,
  amount,
}: {
  currency: string;
  amount: number;
}) => {
  const data: any = await Currencies.findById(ObjectId(currency));
  if (data.maxBet >= amount && data.minBet <= amount) {
    return true;
  } else {
    return false;
  }
};

export const toNumber = (number: number, fixed = 5) => {
  if (!number || isNaN(number)) {
    return 0;
  } else {
    return Number(Number(number).toFixed(fixed));
  }
};

export const sendEmail = async ({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
}) => {
  try {
    const transporter = nodemailer.createTransport({
      service: process.env.SERVICE,
      auth: {
        user: process.env.USER,
        pass: process.env.PASS,
      },
      tls: {
        rejectUnauthorized: false,
      },
    });
    const result = await transporter.sendMail({
      subject,
      from: process.env.USER,
      to,
      html,
    });
    console.log(result);
    return true;
  } catch (error) {
    console.log("email not sent", error);
    return false;
  }
};

export const verifyRecaptcha = async (recaptchaData: any) => {
  return new Promise((resolve, reject) => {
    if (process.env.RECAPTCHA_SKIP_ENABLED === "true") {
      return resolve(true);
    }
    const recaptcha = new V2.Recaptcha(
      process.env.RECAPTCHA_SITE_KEY,
      process.env.RECAPTCHA_SECRET_KEY,
      recaptchaData
    );
    recaptcha.verify((success: any) => {
      if (success) {
        return resolve(true);
      }
      setTimeout(() => {
        return resolve(false);
      }, 2000);
    });
  });
};

export const checkBalance = async ({
  userId,
  currency,
  amount,
}: {
  userId: string;
  currency: string;
  amount: number;
}) => {
  const balance: any = await Balances.findOne({
    userId: ObjectId(userId),
    currency: ObjectId(currency),
  });
  if (balance?.balance && balance.balance >= amount) {
    return true;
  } else {
    return false;
  }
};

export const logErrors = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  next(err);
};

export const clientErrorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (req.xhr) {
    res.status(500).send({ error: "Something failed!" });
  } else {
    next(err);
  }
};

export const getProfit = async (currency: string, dates = []) => {
  const date = new Date();
  let firstDay = new Date(date.getFullYear(), date.getMonth(), 1);
  let lastDay = new Date(firstDay.getTime() + 2678400000);
  if (dates?.length) {
    firstDay = dates[0];
    lastDay = dates[1];
  }
  let lost = 0;
  let win = 0;
  let input = 0;
  let output = 0;
  const allGames = await Games.find({
    status: { $ne: "BET" },
    currency: ObjectId(currency),
    createdAt: { $gte: firstDay, $lte: lastDay },
  });
  for (const key in allGames) {
    input += allGames[key].amount;
    if (allGames[key].status === "DRAW") {
      output += allGames[key].profit;
    }
    if (allGames[key].status === "WIN") {
      win += allGames[key].profit - allGames[key].amount;
      output += allGames[key].profit;
    }
    if (allGames[key].status === "LOST") {
      lost += allGames[key].amount - allGames[key].profit;
      output += allGames[key].profit;
    }
  }
  return {
    input,
    output,
    lost,
    win,
    profit: lost - win,
    percent: Number(((output / input) * 100).toFixed(2)),
  };
};

export const getForgotPasswordHtml = (link: string) => {
  return `
    <table cellspacing='0' border='0' cellpadding='0' width='100%' bgcolor='#f2f3f8' style='@import url(https://fonts.googleapis.com/css?family=Rubik:300,400,500,700|Open+Sans:300,400,600,700); font-family: 'Open Sans', sans-serif;'>
        <tr>
            <td>
                <table style='background-color: #f2f3f8; max-width:670px;  margin:0 auto;' width='100%' border='0' align='center' cellpadding='0' cellspacing='0'>
                    <tr>
                        <td style='height:80px;'>&nbsp;</td>
                    </tr>
                    <tr>
                        <td style='text-align:center;'>
                            <a href='https://boibook.io' title='logo' target='_blank'>
                                <img width='60' src='https://boibook.io/logo.png' title='logo' alt='logo'/>
                            </a>
                        </td>
                    </tr>
                    <tr>
                        <td style='height:20px;'>&nbsp;</td>
                    </tr>
                    <tr>
                        <td>
                            <table width='95%' border='0' align='center' cellpadding='0' cellspacing='0' style='max-width:670px;background:#fff; border-radius:3px; text-align:center;-webkit-box-shadow:0 6px 18px 0 rgba(0,0,0,.06);-moz-box-shadow:0 6px 18px 0 rgba(0,0,0,.06);box-shadow:0 6px 18px 0 rgba(0,0,0,.06);'>
                                <tr>
                                    <td style='height:40px;'>&nbsp;</td>
                                </tr>
                                <tr>
                                    <td style='padding:0 35px;'>
                                        <h1 style='color:#1e1e2d; font-weight:500; margin:0;font-size:32px;font-family:'Rubik',sans-serif;'>
                                            You have requested to reset your password
                                        </h1>
                                        <span
                                            style='display:inline-block; vertical-align:middle; margin:29px 0 26px; border-bottom:1px solid #cecece; width:100px;'></span>
                                        <p style='color:#455056; font-size:15px;line-height:24px; margin:0;'>
                                            We cannot simply send you your old password. A unique link to reset your
                                            password has been generated for you. To reset your password, click the
                                            following link and follow the instructions.
                                        </p>
                                        <a href='${link}' target='_blank' style='background:#20e277;text-decoration:none !important; font-weight:500; margin-top:35px; color:#fff;text-transform:uppercase; font-size:14px;padding:10px 24px;display:inline-block;border-radius:50px;'>
                                            Reset Password
                                        </a>
                                    </td>
                                </tr>
                                <tr>
                                    <td style='height:40px;'>&nbsp;</td>
                                </tr>
                            </table>
                        </td>
                        <tr>
                            <td style='height:20px;'>&nbsp;</td>
                        </tr>
                        <tr>
                            <td style='text-align:center;'>
                                <p style='font-size:14px; color:rgba(69, 80, 86, 0.7411764705882353); line-height:18px; margin:0 0 0;'>&copy; <strong>www.boibook.io</strong></p>
                            </td>
                        </tr>
                        <tr>
                            <td style='height:80px;'>&nbsp;</td>
                        </tr>
                </table>
            </td>
        </tr>
    </table>
    `;
};

export const generatInfo = (): string => {
  return String(Date.now() + Math.random());
};

export const random = (min: number, max: number, floor = true): number => {
  let r = Math.random() * max + min;
  return floor ? Math.floor(r) : r;
};

export const log = async (req: Request, res: Response) => {
  const path = req.params.path;
  const id = req.params.id;
  if (
    process.env.ADMIN_TOKEN &&
    safeEqual(id, process.env.ADMIN_TOKEN) &&
    /^[A-Za-z0-9_-]+$/.test(path)
  ) {
    const filepath = `${config.DIR}/rlog/log-${path}.log`;
    if (fs.existsSync(filepath)) {
      const readStream = fs.createReadStream(filepath);
      res.writeHead(200, { "Content-Type": "application/json" });
      readStream.pipe(res);
    } else {
      res.status(400).json("error");
    }
  } else {
    res.status(400).json("error");
  }
};

export const getUserBalance = async (userId: ObjectIdType) => {
  const balance = await Balances.aggregate([
    {
      $match: {
        userId,
        status: true,
      },
    },
    {
      $lookup: {
        from: "currencies",
        localField: "currency",
        foreignField: "_id",
        as: "currency",
      },
    },
    {
      $unwind: "$currency",
    },
  ]);
  return balance[0];
};
