module.exports = (err, req, res, _next) => {
  console.error(err); // 필요 시 winston/pino로 교체
  const status = err.status || 500;
  res.status(status).json({
    message: err.message || 'Internal Server Error'
  });
};
