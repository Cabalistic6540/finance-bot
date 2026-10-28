export function salaryDatesForMonth(year, monthNumber) {
  return [5, 20].map((nominalDay) => {
    const value = new Date(Date.UTC(year, monthNumber - 1, nominalDay));
    const nominalDate = value.toISOString().slice(0, 10);
    if (value.getUTCDay() === 0) value.setUTCDate(value.getUTCDate() - 1);
    return { nominalDay, nominalDate, date: value.toISOString().slice(0, 10) };
  });
}
export function salaryPeriodForDate(date) {
  const [year, monthNumber] = date.split('-').map(Number);
  return salaryDatesForMonth(year, monthNumber).find((period) => period.date === date) || null;
}
export function nextSalaryDate(date, strictlyAfter = false) {
  const [year, monthNumber] = date.split('-').map(Number);
  return [...salaryDatesForMonth(year, monthNumber), ...salaryDatesForMonth(year, monthNumber + 1)]
    .find((period) => strictlyAfter ? period.date > date : period.date >= date)?.date;
}
