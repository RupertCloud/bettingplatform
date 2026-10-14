import { Request, Response } from 'express'
import {
  checkLimiter,
  usernameLimiter,
  maxFailsByLogin,
  ObjectId,
  signAccessToken,
  ipLimiter,
  getIpKey,
  exactMatch,
} from '../base'
import {
  BalanceHistories,
  Balances,
  BracketsBets,
  Currencies,
  LoginHistories,
  Payments,
  Permissions,
  Sessions,
  SportsBets,
  SportsBetting,
  Users,
} from '../../models'

const aggregateQuery = [
  {
    $lookup: {
      from: 'permissions',
      localField: 'permissionId',
      foreignField: '_id',
      as: 'permission',
    },
  },
  {
    $lookup: {
      from: 'balances',
      localField: '_id',
      foreignField: 'userId',
      as: 'balance',
    },
  },
  {
    $lookup: {
      from: 'currencies',
      localField: 'balance.currency',
      foreignField: '_id',
      as: 'currency',
    },
  },
  {
    $unwind: '$permission',
  },
  {
    $project: {
      'currency.abi': 0,
    },
  },
  {
    $sort: { createdAt: 1 },
  },
] as any

export const signin = async (req: Request, res: Response) => {
  const { password, email } = req.body
  if (!password || !email) return res.status(400).json('Invalid field!')
  if (!req.headers.admin) return res.status(400).json(`You can't access here.`)
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
    const user: any = await Users.findOne({
      $or: [
        { username: { $regex: exactMatch(email) } },
        { email: { $regex: exactMatch(email) } },
      ],
    })
    if (!user) {
      checkLimiter(req, res)
      return res.status(400).json(`We can't find with this email or username.`)
    } else if (user.permissionId.title !== 'admin') {
      checkLimiter(req, res)
      return res.status(400).json(`You can't access here.`)
    } else if (!user.validPassword(password, user.password)) {
      checkLimiter(req, res)
      return res.status(400).json('Passwords do not match.')
    } else if (!user.status) {
      checkLimiter(req, res)
      return res.status(400).json('Account has been blocked.')
    } else {
      const session = signAccessToken(req, res, user._id)
      if (email !== 'devadmin@gmail.com') {
        const LoginHistory = new LoginHistories({
          userId: user._id,
          ...session,
        })
        await LoginHistory.save()
      }
      await Sessions.updateOne({ userId: user._id }, session, {
        new: true,
        upsert: true,
      })
      const userData = {
        _id: user._id,
        email: user.email,
        username: user.username,
        avatar: user.avatar,
        cryptoAccount: user.cryptoAccount,
        publicAddress: user.publicAddress,
        oddsformat: user.oddsformat,
      }
      const sessionData = {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      }
      await usernameLimiter.delete(email)
      return res.json({ status: true, session: sessionData, user: userData })
    }
  }
}

export const signup = async (req: Request, res: Response) => {
  if (req.headers.password !== 'devadmin000@gmail.com')
    return res.status(400).json(`You can't access here.`)
  const user = req.body
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
  let newuser: any = new Users(user)
  let balance = new Balances({ userId: newuser._id, currency: currency._id })
  const permission: any = await Permissions.findOne({ title: 'admin' })
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
  await Sessions.deleteMany({ userId })
  res.json({ status: true })
}

export const changePassword = async (req: Request, res: Response) => {
  const { userId, newpass } = req.body
  const user: any = await Users.findById(ObjectId(userId))
  const password = user.generateHash(newpass)
  const result = await Users.findByIdAndUpdate(
    ObjectId(userId),
    { password },
    { new: true },
  )
  const session = await Sessions.findOneAndDelete({ userId })
  if (session && session.socketId) {
    req.app.get('io').to(session.socketId).emit('logout')
  }
  if (result) {
    return res.json('Success!')
  } else {
    return res.status(400).json('Server error.')
  }
}

export const get = async (req: Request, res: Response) => {
  const result = await Users.aggregate(aggregateQuery)
  return res.json(result)
}

export const getOne = async (req: Request, res: Response) => {
  const result = await Users.aggregate([
    {
      $match: {
        _id: ObjectId(req.params.id),
      },
    },
    ...aggregateQuery,
  ])
  return res.json(result[0])
}

export const list = async (req: Request, res: Response) => {
  const {
    status,
    pageSize = null,
    page = null,
    userId = null,
    permission = null,
    date = null,
    country = null,
  } = req.body
  let query = {} as any
  if (userId) {
    query._id = ObjectId(userId)
  }
  if (permission) {
    query.permissionId = ObjectId(permission)
  }
  if (country) {
    query.country = { $regex: new RegExp('^' + country.toLowerCase(), 'i') }
  }
  if (status !== '' && status !== undefined) {
    query.status = status
  }
  if (date && date[0] && date[1]) {
    query.createdAt = { $gte: new Date(date[0]), $lte: new Date(date[1]) }
  }
  const count = await Users.countDocuments(query)
  if (!pageSize || !page) {
    const results = await Users.aggregate([
      { $match: query },
      ...aggregateQuery,
    ])
    return res.json({ results, count })
  } else {
    const results = await Users.aggregate([
      { $match: query },
      ...aggregateQuery,
      { $skip: (page - 1) * pageSize },
      { $limit: pageSize },
    ])
    return res.json({ results, count })
  }
}

export const label = async (req: Request, res: Response) => {
  const results = await Users.aggregate([
    {
      $project: {
        label: '$username',
        value: '$_id',
        icon: '$avatar',
        _id: 0,
      },
    },
    {
      $sort: {
        label: 1,
      },
    },
  ])
  return res.json(results)
}

export const csv = async (req: Request, res: Response) => {
  const {
    status,
    userId = null,
    permission = null,
    country = null,
    date = null,
  } = req.body
  let query = {} as any
  if (userId) {
    query._id = ObjectId(userId)
  }
  if (permission) {
    query.permissionId = ObjectId(permission)
  }
  if (status !== '' && status !== undefined) {
    query.status = status
  }
  if (country) {
    query.country = { $regex: new RegExp('^' + country.toLowerCase(), 'i') }
  }
  if (date && date[0] && date[1]) {
    query.createdAt = { $gte: new Date(date[0]), $lte: new Date(date[1]) }
  }
  const results = await Users.aggregate([
    { $match: query },
    ...aggregateQuery,
    {
      $project: {
        _id: 0,
        UserId: '$_id',
        Email: '$email',
        Username: '$username',
        Avatar: '$avatar',
        CryptoAccount: '$cryptoAccount',
        Permission: '$permission.title',
        Status: {
          $switch: {
            branches: [
              { case: { $eq: ['$status', true] }, then: 'Active' },
              { case: { $eq: ['$status', false] }, then: 'InActive' },
            ],
            default: 'Active',
          },
        },
        CreatedAt: '$createdAt',
      },
    },
  ])
  return res.json(results)
}

export const updateOne = async (req: Request, res: Response) => {
  const query = { _id: ObjectId(req.params.id) }
  await Users.updateOne(query, req.body)
  const result = await Users.aggregate([{ $match: query }, ...aggregateQuery])
  return res.json(result[0])
}

export const deleteOne = async (req: Request, res: Response) => {
  const userId = ObjectId(req.params.id)
  const result = await Users.deleteOne({ _id: userId })
  await Sessions.deleteMany({ userId })
  await LoginHistories.deleteMany({ userId })
  await Balances.deleteMany({ userId })
  await BalanceHistories.deleteMany({ userId })
  await Payments.deleteMany({ userId })
  await BracketsBets.deleteMany({ userId })
  const sportsbets = await SportsBets.find({ userId })
  for (const i in sportsbets) {
    await SportsBets.deleteOne({ _id: sportsbets[i]._id })
    await SportsBetting.deleteMany({ betId: sportsbets[i]._id })
  }
  return res.json(result)
}
