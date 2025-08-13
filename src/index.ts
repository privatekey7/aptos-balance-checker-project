import chalk from 'chalk';
import * as readline from 'readline';
import { checkAllWallets } from './modules/balance-checker';
import { transferAllToSubAccounts } from './modules/transfer-module';

// Создаем интерфейс для чтения ввода пользователя
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

/**
 * Показывает главное меню и обрабатывает выбор пользователя
 */
async function showMainMenu() {
  console.clear();
  console.log(chalk.cyan.bold('╔══════════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan.bold('║                    APTOS WALLET MANAGER                     ║'));
  console.log(chalk.cyan.bold('╚══════════════════════════════════════════════════════════════╝'));
  console.log();
  console.log(chalk.white('Выберите режим работы:'));
  console.log();
  console.log(chalk.yellow('1.') + ' 📊 Проверить балансы всех кошельков');
  console.log(chalk.yellow('2.') + ' 📤 Отправить весь баланс на субаккаунты');
  console.log(chalk.yellow('3.') + ' ❌ Выход');
  console.log();
}

/**
 * Обрабатывает выбор пользователя
 */
async function handleUserChoice(choice: string) {
  switch (choice.trim()) {
    case '1':
      console.log(chalk.cyan.bold('\n🚀 Запуск проверки балансов...\n'));
      try {
        await checkAllWallets();
      } catch (error) {
        console.error(chalk.red('❌ Ошибка при проверке балансов:'), error);
      }
      break;
      
    case '2':
      console.log(chalk.cyan.bold('\n⚠️  ВНИМАНИЕ! Вы собираетесь отправить ВСЕ средства с кошельков!'));
      console.log();
      
             const confirm = await askQuestion(chalk.green.bold('Продолжить? (Y/N): '));
       if (confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes') {
        console.log(chalk.cyan.bold('\n🚀 Запуск отправки средств...\n'));
        try {
          await transferAllToSubAccounts();
        } catch (error) {
          console.error(chalk.red('❌ Ошибка при отправке средств:'), error);
        }
      } else {
        console.log(chalk.green('✅ Операция отменена'));
      }
      break;
      
    case '3':
      console.log(chalk.green('🛑 Скрипт остановлен'));
      rl.close();
      process.exit(0);
      break;
      
    default:
      console.log(chalk.red('❌ Неверный выбор. Пожалуйста, выберите 1, 2 или 3.'));
      break;
  }
}

/**
 * Задает вопрос пользователю и возвращает ответ
 */
function askQuestion(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

/**
 * Главная функция приложения
 */
async function main() {
  try {
    while (true) {
      await showMainMenu();
      
      const choice = await askQuestion(chalk.cyan('Введите ваш выбор (1-3): '));
      
      await handleUserChoice(choice);
      
      if (choice.trim() !== '3') {
        console.log();
        const continueChoice = await askQuestion(chalk.cyan('Нажмите Enter для возврата в главное меню...'));
      }
    }
  } catch (error) {
    console.error(chalk.red('💥 Критическая ошибка:'), error);
    process.exit(1);
  }
}

// Запускаем приложение
if (require.main === module) {
  main();
}
