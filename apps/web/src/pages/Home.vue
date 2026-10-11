<script setup lang="ts">
import { ArrowRight } from '@element-plus/icons-vue';
import { auth } from '../api';
</script>
<template>
  <div class="home-landing">
    <section class="home-hero" aria-labelledby="home-title">
      <div class="hero-copy">
        <span class="hero-eyebrow"><span class="atom-dot"></span>开放 · 协作 · 探索</span>
        <h1 id="home-title">南晓开放原子社<br /><span>在线报名系统</span></h1>
        <p class="hero-description">
          让热爱相聚，让下一程开始。<br />从个人挑战到团队协作，在这里开启你的参赛旅程。
        </p>
        <div class="hero-actions">
          <router-link to="/contests"
            ><el-button type="primary" size="large"
              >进入报名系统 <el-icon><ArrowRight /></el-icon></el-button
          ></router-link>
          <router-link :to="auth.user ? '/registrations' : '/login?mode=register'"
            ><el-button size="large">{{
              auth.user ? '我的报名' : '创建账号'
            }}</el-button></router-link
          >
        </div>
        <div class="hero-supported">
          <span>Hydro · DOMjudge 账号同步</span>
        </div>
      </div>
      <div class="hero-brands" aria-label="社团与集训队">
        <div class="brand-signature club-signature">
          <div class="brand-image">
            <img src="/brand/openatom-club.jpg" width="366" height="366" alt="开放原子社 Logo" />
          </div>
          <strong>南晓开放原子社</strong>
          <span class="brand-caption">OPENATOM CLUB</span>
        </div>
        <div class="brand-signature team-signature">
          <div class="brand-image">
            <img
              src="/brand/icpc-team.png"
              width="3000"
              height="2000"
              alt="南京晓庄学院 ICPC 集训队 Logo"
            />
          </div>
          <strong class="team-name"
            ><span>南京晓庄学院</span><span>程序设计竞赛集训队</span></strong
          >
          <span class="brand-caption">ICPC TRAINING TEAM</span>
        </div>
      </div>
    </section>
    <div class="home-help">
      <span>报名遇到问题？查看竞赛公告，或提交工单联系我们。</span
      ><router-link to="/support">前往工单中心 <span aria-hidden="true">→</span></router-link>
    </div>
  </div>
</template>
<style scoped>
.home-landing {
  display: flex;
  flex-direction: column;
  justify-content: center;
  width: 100%;
}
.home-hero {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  align-items: center;
  gap: clamp(36px, 4vw, 96px);
  min-height: clamp(420px, 60svh, 560px);
  padding: clamp(48px, 6svh, 100px) var(--landing-inset);
  background: linear-gradient(120deg, #f2f7ff, #f8fbff 65%, #f4f8fd);
  border: 1px solid #e7eef8;
  border-radius: 24px;
}
.hero-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: #64748b;
  font-size: clamp(12px, 0.8vw, 16px);
  letter-spacing: 3px;
}
.atom-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #c81725;
}
.hero-copy h1 {
  font-size: clamp(40px, 4.1vw, 88px);
  line-height: 1.32;
  font-weight: 700;
  letter-spacing: -1px;
  color: #243347;
  margin: clamp(22px, 2vw, 40px) 0;
}
.hero-copy h1 span {
  color: #2080f0;
}
.hero-description {
  color: #69788b;
  font-size: clamp(15px, 1vw, 20px);
  line-height: 1.9;
  margin: 0 0 clamp(30px, 2.5vw, 52px);
}
.hero-actions {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}
.hero-actions .el-button {
  height: clamp(50px, 3.2vw, 64px);
  padding: 0 clamp(22px, 1.8vw, 36px);
  font-size: clamp(15px, 1vw, 19px);
  border-radius: 8px;
}
.hero-actions .el-icon {
  margin-left: 14px;
}
.hero-supported {
  display: flex;
  gap: 12px 24px;
  color: #7b899b;
  font-size: clamp(12px, 0.8vw, 15px);
  margin-top: clamp(22px, 2vw, 36px);
  flex-wrap: wrap;
}
.hero-supported > span {
  white-space: nowrap;
}
.hero-brands {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.35fr);
  align-items: start;
  gap: clamp(20px, 2.3vw, 52px);
}
.brand-signature {
  min-width: 0;
  text-align: center;
}
.brand-image {
  height: clamp(180px, 16vw, 360px);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 28px;
}
.brand-image img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  height: auto;
  object-fit: contain;
  mix-blend-mode: multiply;
}
.club-signature img {
  width: clamp(110px, 10vw, 230px);
}
.team-signature img {
  width: 420px;
}
.brand-signature strong {
  display: block;
  color: #3b4b62;
  font-size: clamp(13px, 0.9vw, 20px);
  font-weight: 600;
  line-height: 1.6;
}
.brand-caption {
  display: block;
  color: #8a98ab;
  font-size: clamp(9px, 0.65vw, 13px);
  letter-spacing: 1.5px;
  line-height: 1.6;
  margin-top: 7px;
}
.home-help {
  margin: 22px var(--landing-inset) 0;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: clamp(12px, 0.75vw, 14px);
  color: #8794a5;
  line-height: 1.8;
}
.home-help a {
  white-space: nowrap;
}
@media (min-width: 1001px) and (max-height: 800px) {
  .home-hero {
    padding-block: 28px;
  }
  .hero-copy h1 {
    font-size: clamp(40px, 4.1vw, 56px);
    margin: 22px 0;
  }
  .hero-description {
    font-size: 15px;
    margin-bottom: 28px;
  }
  .hero-actions .el-button {
    height: 50px;
    font-size: 15px;
    padding-inline: 23px;
  }
  .hero-supported {
    margin-top: 22px;
  }
  .brand-image {
    height: clamp(180px, 26svh, 240px);
  }
}
@media (max-width: 1000px) {
  .home-hero {
    grid-template-columns: 1fr;
    gap: 32px;
    min-height: 0;
    padding-block: 40px;
  }
  .hero-copy h1 {
    font-size: 44px;
  }
  .hero-brands {
    width: 100%;
    max-width: 540px;
    justify-self: center;
    padding-top: 24px;
    border-top: 1px solid #dde7f4;
  }
  .brand-image {
    height: 180px;
    margin-bottom: 18px;
  }
  .club-signature img {
    width: 125px;
  }
}
@media (max-width: 600px) {
  .home-hero {
    gap: 32px;
    padding-block: 34px;
    border-radius: 16px;
  }
  .hero-copy h1 {
    font-size: clamp(28px, 8vw, 40px);
    letter-spacing: 0;
    margin: 22px 0;
  }
  .hero-description {
    font-size: 14px;
    margin-bottom: 26px;
  }
  .hero-actions {
    gap: 10px;
  }
  .hero-actions .el-button {
    height: 48px;
    font-size: 14px;
    padding: 0 18px;
  }
  .hero-supported {
    gap: 10px;
    margin-top: 20px;
  }
  .hero-brands {
    gap: 18px;
  }
  .brand-image {
    height: 128px;
    margin-bottom: 16px;
  }
  .club-signature img {
    width: 88px;
  }
  .brand-signature strong {
    font-size: 12px;
    min-height: 3.2em;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .team-name > span {
    white-space: nowrap;
  }
  .brand-caption {
    font-size: 8px;
    letter-spacing: 0.8px;
  }
  .home-help {
    margin: 18px var(--landing-inset) 0;
    display: block;
    font-size: 12px;
  }
  .home-help a {
    display: inline-block;
    margin-top: 6px;
  }
}
@media (max-width: 360px) {
  .hero-actions .el-button {
    padding-inline: 14px;
  }
}
</style>
