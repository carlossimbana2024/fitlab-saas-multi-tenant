import { beforeEach,describe,expect,it,vi } from 'vitest';
import type { Request,Response } from 'express';
const mock=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn(),storage:{from:vi.fn()}}));
vi.mock('../src/config/supabase.js',()=>({supabaseAdmin:mock}));
import { socialProfileSchema,galleryChangeSchema,galleryPathOwned,galleryImageMime,getMemberSocialProfile,changeMyGalleryPhoto,updateMySocialProfile } from '../src/controllers/memberSocialProfile.controller.js';
const g='00000000-0000-4000-8000-000000000001';const actor='00000000-0000-4000-8000-000000000002';const other='00000000-0000-4000-8000-000000000003';
const request=(body:object={},params:object={},role='member')=>({body,params,tenant:{gymId:g,gymUserId:actor,role,timezone:'America/Guayaquil'}}) as unknown as Request;
const response=()=>({json:vi.fn(),setHeader:vi.fn()}) as unknown as Response;
describe('perfil social privado',()=>{
 beforeEach(()=>vi.clearAllMocks());
 it('admite emojis y rechaza campos privados, bio larga y cuarta foto',()=>{
  expect(socialProfileSchema.safeParse({bio:'💪 Entrena',showGallery:false,showBadges:false}).success).toBe(true);
  expect(socialProfileSchema.safeParse({bio:'x'.repeat(161),showGallery:false,showBadges:false}).success).toBe(false);
  expect(socialProfileSchema.safeParse({bio:'Hola',showGallery:false,showBadges:false,memberId:other}).success).toBe(false);
  expect(galleryChangeSchema.safeParse({slot:3,path:null}).success).toBe(false);
 });
 it('permite cambios individuales sin enviar ni sobrescribir otras preferencias',async()=>{
  expect(socialProfileSchema.safeParse({}).success).toBe(false);
  expect(socialProfileSchema.safeParse({showGallery:true}).success).toBe(true);
  expect(socialProfileSchema.safeParse({bio:'Nueva bio'}).success).toBe(true);
  mock.rpc.mockResolvedValue({data:{},error:null});
  await updateMySocialProfile(request({showBadges:true}),response());
  expect(mock.rpc).toHaveBeenCalledWith('update_member_social_profile_backend',{g,actor,input:{showBadges:true}});
 });
 it('valida propiedad del gimnasio y miembro y contenido real de imágenes',()=>{
  const path=`${g}/${actor}/${other}.webp`;
  expect(galleryPathOwned(path,g,actor)).toBe(true);expect(galleryPathOwned(path,g,other)).toBe(false);
  expect(galleryImageMime(Buffer.from('%PDF-falso'))).toBe(null);
  expect(galleryImageMime(Buffer.from('RIFFxxxxWEBP'))).toBe('image/webp');
 });
 it('no permite al owner escribir la identidad del miembro',async()=>{
  await expect(updateMySocialProfile(request({}, {},'owner'),response())).rejects.toMatchObject({statusCode:403});expect(mock.rpc).not.toHaveBeenCalled();
 });
 it('no revela fotos ni campos privados de perfiles ocultos',async()=>{
  const query={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:null,error:null})};mock.from.mockReturnValue(query);
  await expect(getMemberSocialProfile(request({}, {memberId:other}),response())).rejects.toMatchObject({statusCode:404});
  expect(query.eq).toHaveBeenCalledWith('gym_id',g);expect(mock.storage.from).not.toHaveBeenCalled();
 });
 it('rechaza rutas de fotos ajenas antes de consultar storage',async()=>{
  await expect(changeMyGalleryPhoto(request({slot:0,path:`${g}/${other}/${actor}.png`}),response())).rejects.toMatchObject({statusCode:400});
  expect(mock.storage.from).not.toHaveBeenCalled();expect(mock.rpc).not.toHaveBeenCalled();
 });
 it('un perfil visible oculta métricas, galería y datos personales no autorizados',async()=>{
  mock.from.mockImplementation((table:string)=>{
   const data=table==='gym_users'?{id:other,profiles:{full_name:'Atleta',avatar_url:'private',phone:'SECRET',email:'SECRET'}}:
    table==='member_fitness_profiles'?{show_in_community:true,show_profile_photo:false,show_streak:false,show_attendance_count:false,show_goal:false,show_weight_progress:false,weight_kg:80,target_weight_kg:70}:
    table==='member_social_profiles'?{bio:'Hola',gallery_paths:[`${g}/${other}/${actor}.webp`,null,null],show_gallery:false,show_badges:false}:null;
   const result={data,error:null,count:2};return {select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue(result),then:(resolve:(value:object)=>unknown)=>Promise.resolve(result).then(resolve)};
  });
  const res=response();await getMemberSocialProfile(request({}, {memberId:other}),res);
  const p=(res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].profile;
  expect(p.gallery).toEqual([null,null,null]);expect(p.avatarUrl).toBe(null);expect(p.streak).toBe(null);expect(p.monthlyAttendances).toBe(null);expect(p.progressPercent).toBe(null);expect(p.badges).toEqual([]);
  expect(JSON.stringify(p)).not.toContain('SECRET');expect(p).not.toHaveProperty('weight_kg');expect(mock.storage.from).not.toHaveBeenCalled();
 });
});
