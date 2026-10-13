import * as randomString from 'randomstring'
import { bufferToHex } from 'ethereumjs-util'
import { Request, Response } from 'express'
import { recoverPersonalSignature } from 'eth-sig-util'

import * as nacl from 'tweetnacl'
import * as bs58 from 'bs58'

import {
  Users,
  Sessions,
  Permissions,
  Balances,
  Currencies,
  LoginHistories,
  BalanceHistories,
} from '../../models'
import {
  signAccessToken,
  ObjectId,
  getIPAddress,
  sendEmail,
  verifyRecaptcha,
  getForgotPasswordHtml,
  getSessionTime,
  usernameLimiter,
  maxFailsByLogin,
  checkLimiter,
  ipLimiter,
  getIpKey,
  getUserBalance,
  newToken,
  exactMatch,
} from '../base'

const userInfo = (user: any) => {
  return {
    _id: user._id,
    email: user.email,
    username: user.username,
    avatar: user.avatar,
    cryptoAccount: user.cryptoAccount,
    publicAddress: user.publicAddress,
    oddsformat: user.oddsformat,
    iReferral: user.iReferral,
    rReferral: user.rReferral,
    pReferral: user.pReferral,
  }
}

export const signin = async (req: Request, res: Response) => {
  const { password, email, recaptcha } = req.body
  const rlResIp = await ipLimiter.get(getIpKey(req))
  const rlResUsername = await usernameLimiter.get(email)
  if (
    rlResUsername !== null &&
    rlResUsername.consumedPoints > maxFailsByLogin
  ) {
    const retrySecs = Math.round(rlResUsername.msBeforeNext / 1000)
    res.set('Retry-After', String(retrySecs))
    return res.status(429).send('Too Many Requests.')
  } else if (rlResIp !== null && rlResIp.consumedPoints > maxFailsByLogin) {
    const retrySecs = Math.round(rlResIp.msBeforeNext / 1000) || 1
    res.set('Retry-After', String(retrySecs))
    return res.status(429).send('Too Many Requests.')
  } else {
    if (process.env.MODE === 'pro') {
      const recaptchaData = {
        remoteip: req.connection.remoteAddress,
        response: recaptcha,
        secret: process.env.RECAPTCHA_SECRET_KEY,
      }
      const recaptchaResult = await verifyRecaptcha(recaptchaData)
      if (!recaptchaResult) {
        checkLimiter(req, res)
        return res.status(400).json('Please check the robot again!')
      }
    }
    const user: any = await Users.findOne({
      $or: [
        { username: { $regex: exactMatch(email) } },
        { email: { $regex: exactMatch(email) } },
      ],
    })
    if (!user) {
      checkLimiter(req, res)
      return res.status(400).json(`We can't find with this email or username.`)
    } else if (!user.validPassword(password, user.password)) {
      checkLimiter(req, res)
      return res.status(400).json('Passwords do not match.')
    } else if (!user.status) {
      checkLimiter(req, res)
      return res.status(400).json('Account has been blocked.')
    } else {
      const session = signAccessToken(req, res, user._id)
      const LoginHistory = new LoginHistories({
        userId: user._id,
        ...session,
        data: req.body,
      })
      await LoginHistory.save()
      await Sessions.updateOne({ userId: user._id }, session, {
        new: true,
        upsert: true,
      })
      const userData = userInfo(user)
      const sessionData = {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      }
      await usernameLimiter.delete(email)
      const balance = await getUserBalance(user._id)
      return res.json({
        status: true,
        session: sessionData,
        user: userData,
        balance,
      })
    }
  }
}

export const signup = async (req: Request, res: Response) => {
  const user = req.body
  const recaptchaData = {
    remoteip: req.connection.remoteAddress,
    response: user.recaptcha,
    secret: process.env.RECAPTCHA_SECRET_KEY,
  }
  const recaptchaResult = await verifyRecaptcha(recaptchaData)
  if (!recaptchaResult) {
    return res.status(400).json('Please check the robot again!')
  }
  const ip = getIPAddress(req)
  // const ipCount = await Users.countDocuments({ ip: { '$regex': ip.ip, '$options': 'i' } })
  // if (ipCount > 1) {
  //     return res.status(400).json(`Account limited.`)
  // }
  const emailExists = await Users.findOne({
    email: { $regex: exactMatch(user.email) },
  })
  if (emailExists) {
    return res.status(400).json(`${user.email} is used by another account.`)
  }
  const usernameExists = await Users.findOne({
    username: { $regex: exactMatch(user.username) },
  })
  if (usernameExists) {
    return res
      .status(400)
      .json(`An account named '${user.username}' already exists.`)
  }
  const currency = await Currencies.findOne({ symbol: 'SOL' })
  if (!currency) {
    return res.status(400).json('error')
  }
  const iReferral = randomString.generate(10)
  let newuser: any = new Users({ ...user, ...ip, iReferral })
  let balance = new Balances({ userId: newuser._id, currency: currency._id })
  const permission: any = await Permissions.findOne({ title: 'player' })
  newuser.password = newuser.generateHash(user.password)
  newuser.permissionId = permission._id
  newuser.status = true

  const u_result = await newuser.save()
  const b_result = await balance.save()
  if (!u_result || !b_result) {
    return res.status(400).json('error')
  } else {
    return res.json('You have successfully created in as a user to Boibook.')
  }
}

export const signout = async (req: Request, res: Response) => {
  const { userId } = req.body
  const result = await Sessions.deleteMany({ userId })
  res.json(result)
}

export const checkAddress = async (req: Request, res: Response) => {
  const { publicAddress } = req.body
  const user = await Users.findOne({
    publicAddress: {
      $regex: exactMatch(publicAddress),
    },
  })
  if (!user) {
    return res.json({
      status: false,
      message: `We can't find with this account.`,
    })
  } else if (!user.status) {
    return res.status(400).json('Account has been blocked.')
  }
  return res.json({
    status: true,
    user: { publicAddress: user.publicAddress, nonce: user.nonce },
  })
}

export const joinAddress = async (req: Request, res: Response) => {
  const { publicAddress } = req.body
  const ip = getIPAddress(req)
  // const ipCount = await Users.countDocuments({ ip: { '$regex': ip.ip, '$options': 'i' } })
  // if (ipCount > 1) {
  //     return res.status(400).json(`Account limited.`)
  // }
  const exists = await Users.findOne({
    publicAddress: {
      $regex: exactMatch(publicAddress),
    },
  })
  if (exists) {
    return res.status(400).json(`${publicAddress} is used by another account.`)
  }
  const currency = await Currencies.findOne({ symbol: 'SOL' })
  if (!currency) {
    return res.status(400).json('error')
  }
  const iReferral = randomString.generate(10)
  let newuser = new Users({
    publicAddress,
    nonce: Date.now(),
    username: publicAddress,
    email: publicAddress,
    iReferral,
    rReferral: req.body.rReferral,
    ...ip,
  })
  let balance = new Balances({ userId: newuser._id, currency: currency._id })
  const permission: any = await Permissions.findOne({ title: 'player' })
  newuser.permissionId = permission._id
  newuser.status = true
  const u_result = await newuser.save()
  const b_result = await balance.save()
  if (!u_result || !b_result) {
    return res.status(400).json('error')
  } else {
    return res.json('You have successfully created in as a user to Boibook.')
  }
}

export const signinMetamask = async (req: Request, res: Response) => {
  const { signature, publicAddress } = req.body
  const user: any = await Users.findOne({
    publicAddress: {
      $regex: exactMatch(publicAddress),
    },
  })
  if (!user) {
    return res
      .status(400)
      .json(`User with publicAddress ${publicAddress} is not found.`)
  } else if (!user.status) {
    return res.status(400).json('Account has been blocked.')
  }
  const msg = `${process.env.SIGNIN_MESSAGE}: ${user.nonce}`
  const msgBufferHex = bufferToHex(Buffer.from(msg, 'utf8'))
  const address = recoverPersonalSignature({
    data: msgBufferHex,
    sig: signature,
  })
  if (address.toLowerCase() !== publicAddress.toLowerCase()) {
    return res.status(400).json('Signature verification failed.')
  }
  user.nonce = Date.now()
  const result = await user.save()
  if (!result) {
    return res.status(400).json('error')
  }
  const session = signAccessToken(req, res, user._id)
  const LoginHistory = new LoginHistories({
    userId: user._id,
    ...session,
    data: req.body,
  })
  await LoginHistory.save()
  await Sessions.updateOne({ userId: user._id }, session, {
    new: true,
    upsert: true,
  })
  const userData = userInfo(user)
  const sessionData = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
  }
  const balance: any = await getUserBalance(user._id)
  return res.json({
    status: true,
    session: sessionData,
    user: userData,
    balance,
  })
}

export const signinAddress = async (req: Request, res: Response) => {
  const { signature, publicAddress } = req.body
  const user: any = await Users.findOne({
    publicAddress: {
      $regex: exactMatch(publicAddress),
    },
  })
  if (!user) {
    return res
      .status(400)
      .json(`User with publicAddress ${publicAddress} is not found.`)
  } else if (!user.status) {
    return res.status(400).json('Account has been blocked.')
  }
  const msg = `boibook: ${user.nonce}`

  const verified = nacl.sign.detached.verify(
    new TextEncoder().encode(msg),
    bs58.decode(signature),
    bs58.decode(publicAddress),
  )

  if (verified != true) {
    return res.status(400).json('Signature verification failed.')
  }
  user.nonce = Date.now()
  const result = await user.save()
  if (!result) {
    return res.status(400).json('error')
  }
  const session = signAccessToken(req, res, user._id)

  const LoginHistory = new LoginHistories({
    userId: user._id,
    ...session,
    data: req.body,
  })
  await LoginHistory.save()

  await Sessions.updateOne({ userId: user._id }, session, {
    new: true,
    upsert: true,
  })
  const userData = userInfo(user)
  const sessionData = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
  }
  const balance = await getUserBalance(user._id)
  return res.json({
    status: true,
    session: sessionData,
    user: userData,
    balance,
  })
}

export const info = async (req: Request, res: Response) => {
  let result = {}
  if (req.body.update) {
    const { userId, email, username, avatar } = req.body
    const emailExists = await Users.findOne({
      _id: { $ne: ObjectId(userId) },
      email: { $regex: exactMatch(email) },
    })
    if (emailExists) {
      return res.status(400).json(`${email} is used by another account.`)
    }
    const usernameExists = await Users.findOne({
      _id: { $ne: ObjectId(userId) },
      username: { $regex: exactMatch(username) },
    })
    if (usernameExists) {
      return res
        .status(400)
        .json(`An account named '${username}' already exists.`)
    }
    const userData: any = await Users.findById(ObjectId(userId))
    if (!userData.status) {
      return res.status(400).json('Account has been blocked.')
    }
    if (
      userData.publicAddress === email ||
      userData.publicAddress === username
    ) {
      const user = await Users.findByIdAndUpdate(
        ObjectId(userId),
        { avatar },
        { new: true },
      )
      result = userInfo(user)
    } else {
      const user = await Users.findByIdAndUpdate(ObjectId(userId), req.body, {
        new: true,
      })
      result = userInfo(user)
    }
  } else {
    if (req.body.iReferral) {
      const userByReferral = await Users.findOne({
        iReferral: req.body.iReferral,
      })
      if (userByReferral != null) {
        return res
          .status(400)
          .json(
            `Your referral code ${req.body.iReferral} is used by another account.`,
          )
      }
    }
    const user = await Users.findOneAndUpdate(
      { _id: ObjectId(req.body.userId), status: true },
      req.body,
      { new: true },
    )
    result = userInfo(user)
  }
  return res.json(result)
}

export const changePassword = async (req: Request, res: Response) => {
  const { userId } = req.body
  const user: any = await Users.findById(ObjectId(userId))
  if (!user.validPassword(req.body['Current Password'], user.password)) {
    return res.status(400).json('Passwords do not match.')
  }
  const password = user.generateHash(req.body['New Password'])
  const result = await Users.findOneAndUpdate(
    { _id: ObjectId(userId), status: true },
    { password },
    { new: true },
  )
  if (result) {
    return res.json('Success!')
  } else {
    return res.status(400).json('Server error.')
  }
}

export const forgot = async (req: Request, res: Response) => {
  const { email, recaptcha } = req.body
  const recaptchaData = {
    remoteip: req.connection.remoteAddress,
    response: recaptcha,
    secret: process.env.RECAPTCHA_SECRET_KEY,
  }
  const recaptchaResult = await verifyRecaptcha(recaptchaData)
  if (!recaptchaResult) {
    return res.status(400).json('Please check the robot again!')
  }
  const user: any =
    typeof email === 'string' ? await Users.findOne({ email }) : null
  if (user) {
    const ip = getIPAddress(req)
    const expiration = getSessionTime()
    // Expiry is part of the stored token, so it cannot be altered (30 min).
    const passwordToken = `${newToken()}.${Date.now() + 30 * 60 * 1000}`
    const session = { passwordToken, expiration, ...ip }
    await Sessions.updateOne({ userId: user._id }, session, {
      new: true,
      upsert: true,
    })
    const subject = 'Forgot Password'
    const link = `${
      process.env.MODE === 'dev'
        ? process.env.DEV_BASE_URL
        : process.env.BASE_URL
    }password-reset/${user._id}/${passwordToken}`
    const html = getForgotPasswordHtml(link)
    await sendEmail({ to: email, html, subject })
    return res.json(
      'We just sent you an email with instructions for resetting your password.',
    )
  } else {
    return res.json(
      'We just sent you an email with instructions for resetting your password.',
    )
  }
}

export const passwordReset = async (req: Request, res: Response) => {
  const { userId, token, password } = req.body
  if (
    typeof token !== 'string' ||
    !/^[0-9a-f]{64}\.\d+$/.test(token) ||
    Number(token.split('.')[1]) < Date.now()
  )
    return res.status(400).json('Invalid link or expired')
  const user: any = await Users.findById(userId)
  if (!user) return res.status(400).json('invalid link or expired')
  const sessions = await Sessions.findOne({
    userId: user._id,
    passwordToken: token,
  })
  if (!sessions) return res.status(400).json('Invalid link or expired')
  user.password = user.generateHash(password)
  await user.save()
  await sessions.delete()
  return res.json('password reset sucessfully.')
}

export const getReferral = async (req: any, res: Response) => {
  const { userId } = req.body
  const invited = await Users.countDocuments({ rReferral: req.user.iReferral })
  const rewards = await BalanceHistories.aggregate([
    {
      $match: {
        userId: ObjectId(userId),
        type: 'referral-bonus',
      },
    },
    {
      $lookup: {
        from: 'currencies',
        localField: 'currency',
        foreignField: '_id',
        as: 'currency',
      },
    },
    {
      $unwind: '$currency',
    },
    {
      $group: {
        _id: {
          currency: '$currency',
        },
        amount: { $sum: '$amount' },
      },
    },
    {
      $project: {
        amount: { $multiply: ['$amount', '$_id.currency.price'] },
      },
    },
    {
      $group: {
        _id: null,
        rewards: { $sum: '$amount' },
      },
    },
  ])
  const reward = rewards.length ? rewards[0]?.rewards : 0
  return res.json({ invited, rewards: reward })
}
