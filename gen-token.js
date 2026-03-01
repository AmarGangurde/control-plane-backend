import jwt from 'jsonwebtoken';
const JWT_SECRET = 'a024fd052b7ce6cc45f71516ac0e4209e278312c63ee639261894a6e088d6922';
const userId = '0d8cdc5e-5c32-446e-afeb-bbddedac7329';
const email = 'agangurde1000@gmail.com';
const token = jwt.sign({ sub: userId, email }, JWT_SECRET, { expiresIn: '7d' });
console.log(token);
