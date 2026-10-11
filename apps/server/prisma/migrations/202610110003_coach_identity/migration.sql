ALTER TABLE "RegistrationCoach" ADD CONSTRAINT "RegistrationCoach_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
